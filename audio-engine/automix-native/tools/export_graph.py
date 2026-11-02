"""Compile a public fixed ONNX graph to the bounded Twilight float32 IR.

This tool and ORT are development dependencies. Model binaries belong in the
external asset cache/release staging directory, never in the source repository.
The runtime schedules attention in small query blocks within its fixed scratch
budget. Every key/value participates without retaining a quadratic score tensor.
"""
import argparse
import hashlib
import json
import math
import struct
from pathlib import Path
import numpy as np
import onnx
from onnx import helper, numpy_helper

OPS = {name: i + 1 for i, name in enumerate([
    "Copy", "Transpose", "Add", "Mul", "Div", "Erf", "Neg", "Sigmoid", "Relu",
    "Clip", "ReduceL2", "Softmax", "MatMul", "Conv", "BatchNormalization",
    "Expand", "Split", "Slice", "Concat", "GlobalAveragePool", "Gemm", "Attention"])}
MAX_RANK = 8

def compile_graph(source, destination):
    model = onnx.load(source)
    values = list(model.graph.value_info) + list(model.graph.input) + list(model.graph.output)
    shapes = {v.name: [d.dim_value for d in v.type.tensor_type.shape.dim] for v in values}
    constants = {v.name: numpy_helper.to_array(v) for v in model.graph.initializer}
    shapes.update({k: list(v.shape) for k, v in constants.items()})
    consumers = {}
    producers = {s: n for n in model.graph.node for s in n.output}
    for n in model.graph.node:
        for s in n.input:
            consumers.setdefault(s, []).append(n)
    removed = set()
    fused = {}
    for n in model.graph.node:
        if n.op_type != "MatMul":
            continue
        soft = producers.get(n.input[0])
        if soft is None or soft.op_type != "Softmax":
            continue
        qk = producers.get(soft.input[0])
        if qk is None or qk.op_type != "MatMul":
            continue
        attr = {v.name: helper.get_attribute_value(v) for v in soft.attribute}
        if attr.get("axis", -1) not in [-1, len(shapes[soft.output[0]]) - 1]:
            continue
        if len(consumers[qk.output[0]]) != 1 or len(consumers[soft.output[0]]) != 1:
            continue
        fused[n.name] = [qk.input[0], qk.input[1], n.input[1]]
        removed.update([qk.name, soft.name])
    nodes = []
    for node in model.graph.node:
        if node.name in removed:
            continue
        op = node.op_type
        ins = list(node.input)
        outs = list(node.output)
        attrs = {v.name: helper.get_attribute_value(v) for v in node.attribute}
        param = [0] * 24
        floats = [0.0] * 4
        rank = len(shapes[ins[0]])
        if node.name in fused:
            op, ins = "Attention", fused[node.name]
        elif op in ["Reshape", "Squeeze", "Unsqueeze", "Cast"]:
            if op == "Cast" and attrs["to"] != onnx.TensorProto.FLOAT:
                raise ValueError("non-float dynamic cast")
            op, ins = "Copy", ins[:1]
        elif op == "Transpose":
            perm = attrs.get("perm", list(reversed(range(rank))))
            param[:rank] = perm
        elif op in ["ReduceL2", "Softmax", "Concat", "Split"]:
            axes = attrs.get("axes", [attrs.get("axis", -1 if op == "Softmax" else 0)])
            if len(axes) != 1:
                raise ValueError("Only single-axis reductions supported")
            param[0] = axes[0] % rank
            if op == "Split":
                ins = ins[:1]
        elif op == "Clip":
            floats[:2] = [float(constants[ins[1]].item()) if len(ins) > 1 and ins[1] else -np.finfo(np.float32).max,
                          float(constants[ins[2]].item()) if len(ins) > 2 and ins[2] else np.finfo(np.float32).max]
            ins = ins[:1]
        elif op == "Expand":
            ins = ins[:1]
        elif op == "Slice":
            starts, ends = [constants[v].flatten().tolist() for v in ins[1:3]]
            axes = constants[ins[3]].flatten().tolist() if len(ins) > 3 else list(range(len(starts)))
            steps = constants[ins[4]].flatten().tolist() if len(ins) > 4 else [1] * len(starts)
            param[8:16] = [1] * 8
            for start, end, axis, step in zip(starts, ends, axes, steps):
                axis %= rank
                start, _, step = slice(start, end, step).indices(shapes[ins[0]][axis])
                param[axis], param[8 + axis] = start, step
            ins = ins[:1]
        elif op == "Conv":
            if attrs.get("auto_pad", b"NOTSET") != b"NOTSET":
                raise ValueError("Conv needs explicit padding")
            param[:9] = [attrs.get("group", 1)] + attrs.get("strides", [1, 1]) + attrs.get("pads", [0] * 4) + attrs.get("dilations", [1, 1])
        elif op == "BatchNormalization":
            floats[0] = attrs.get("epsilon", 1e-5)
        elif op == "Gemm":
            param[:2] = [attrs.get("transA", 0), attrs.get("transB", 0)]
            floats[:2] = [attrs.get("alpha", 1.0), attrs.get("beta", 1.0)]
        if op not in OPS:
            raise ValueError(f"Unsupported {op}")
        nodes.append((op, ins, outs, param, floats, node.name))
    inputs = [v.name for v in model.graph.input]
    outputs = [v.name for v in model.graph.output]
    names = list(dict.fromkeys(inputs + [s for n in nodes for s in n[1] + n[2]] + outputs))
    indices = {s: i for i, s in enumerate(names)}
    for s in names:
        if s not in shapes or len(shapes[s]) > MAX_RANK:
            raise ValueError(f"Missing fixed shape: {s}")
    last = {s: -1 for s in names}
    for i, (_, ins, _, _, _, _) in enumerate(nodes):
        for s in ins:
            last[s] = i
    for s in outputs:
        last[s] = len(nodes)
    offsets, allocated, free = {}, {}, []
    arena = 0
    def allocate(s):
        nonlocal arena
        size = (math.prod(shapes[s]) * 4 + 63) // 64 * 64
        if not size:
            offsets[s] = 0
            return
        for j, (pos, length) in enumerate(free):
            if length >= size:
                offsets[s] = pos
                free.pop(j)
                if length > size:
                    free.append((pos + size, length - size))
                allocated[s] = (pos, size)
                return
        offsets[s] = arena
        allocated[s] = (arena, size)
        arena += size
    def release(s):
        if s not in allocated:
            return
        free.append(allocated.pop(s))
        free.sort()
        merged = []
        for pos, size in free:
            if merged and sum(merged[-1]) == pos:
                merged[-1] = (merged[-1][0], merged[-1][1] + size)
            else:
                merged.append((pos, size))
        free[:] = merged
    blob = bytearray()
    for s in names:
        if s in constants:
            offsets[s] = len(blob)
            blob.extend(np.ascontiguousarray(constants[s], dtype="<f4").tobytes())
    for s in inputs:
        allocate(s)
    scratch = 0
    for i, (op, ins, outs, _, _, _) in enumerate(nodes):
        for s in outs:
            allocate(s)
        if op == "Conv":
            scratch = max(scratch, math.prod(shapes[ins[1]][1:]) * math.prod(shapes[outs[0]][2:]) * 4)
        elif op == "Attention":
            scratch = max(scratch, shapes[ins[1]][-1] * 4)
        elif op == "Gemm":
            scratch = max(scratch, math.prod(shapes[ins[1]]) * 4)
        for s in list(allocated):
            if last[s] <= i:
                release(s)
    assert arena <= 512 * 1024 ** 2 and scratch <= 128 * 1024 ** 2
    destination.parent.mkdir(parents=True, exist_ok=True)
    with destination.open("wb") as f:
        f.write(b"TAMG0001")
        f.write(struct.pack("<4I3Q", len(names), len(nodes), len(inputs), len(outputs), arena, scratch, len(blob)))
        for s in names:
            dims = shapes[s] + [1] * (8 - len(shapes[s]))
            f.write(struct.pack("<2I8I2Q", len(shapes[s]), int(s in constants), *dims, math.prod(shapes[s]), offsets[s]))
        for op, ins, outs, param, floats, _ in nodes:
            assert len(ins) <= 8 and len(outs) <= 8
            f.write(struct.pack("<3I16I24i4f", OPS[op], len(ins), len(outs),
                                *([indices[s] for s in ins] + [0] * (8 - len(ins))),
                                *([indices[s] for s in outs] + [0] * (8 - len(outs))), *param, *floats))
        f.write(struct.pack("<" + "I" * (len(inputs) + len(outputs)), *[indices[s] for s in inputs + outputs]))
        f.write(blob)
    report = {"irVersion": 1, "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
              "graphSha256": hashlib.sha256(destination.read_bytes()).hexdigest(),
              "tensors": len(names), "nodes": len(nodes), "arenaBytes": arena,
              "scratchBytes": scratch, "weightsBytes": len(blob), "fusedAttention": len(fused),
              "inputs": {s: shapes[s] for s in inputs}, "outputs": {s: shapes[s] for s in outputs}}
    destination.with_suffix(".manifest.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    destination.with_suffix(".debug.json").write_text(json.dumps({"tensors": names, "nodes": [n[5] for n in nodes]}), encoding="utf-8")
    print(json.dumps(report, indent=2))

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("source", type=Path)
    p.add_argument("destination", type=Path)
    a = p.parse_args()
    compile_graph(a.source, a.destination)

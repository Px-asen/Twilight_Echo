"""Reproduce the PCM->DSD CIFB feedback coefficients (Python standard library).

NTF(z) = (z-1)^N / D(z), with bilinear-transformed Butterworth poles and
NTF(-1) = 1.5 (order 5) or 1.4 (order 7).
Writing D(1+q) = q^N + k[N-1] q^(N-1) + ... + k[0]
gives the coefficients used by the integrator recurrence in PcmToDsdModulator.
The pole check establishes linearized stability; native signal tests exercise
the nonlinear one-bit loop at its actual input headroom.
"""

import cmath
import math


def poles(order, cutoff):
    analog = [cutoff * cmath.exp(1j * (math.pi / 2 + (2 * k + 1) * math.pi / (2 * order)))
              for k in range(order)]
    return [(2 + pole) / (2 - pole) for pole in analog]


def design(order, peak_gain):
    low, high = 0.0, 2.0
    for _ in range(80):
        cutoff = (low + high) / 2
        peak = abs((-2.0) ** order / math.prod(-1 - pole for pole in poles(order, cutoff)))
        if peak > peak_gain:
            high = cutoff
        else:
            low = cutoff
    cutoff = (low + high) / 2
    digital = poles(order, cutoff)
    coefficients = [1.0 + 0j]
    for pole in digital:
        # Multiply by q - (pole - 1), keeping coefficients in ascending order.
        product = [0j] * (len(coefficients) + 1)
        for power, coefficient in enumerate(coefficients):
            product[power] += (1 - pole) * coefficient
            product[power + 1] += coefficient
        coefficients = product
    print(f"order={order} peakGain={peak_gain} cutoff={cutoff:.17g} maxPoleRadius={max(map(abs, digital)):.17g}")
    print(", ".join(f"{coefficient.real:.17g}" for coefficient in coefficients[:-1]))


if __name__ == "__main__":
    for order, peak_gain in ((5, 1.5), (7, 1.4)):
        design(order, peak_gain)

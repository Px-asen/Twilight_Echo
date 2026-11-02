/** Quiet, original Web Audio ambience. No tracks, remote requests, or autoplay. */
export class EchoSound {
  private context: AudioContext | null = null;
  private output: GainNode | null = null;
  private timer: number | null = null;
  private active = false;
  private step = 0;

  async toggle(): Promise<boolean> {
    if (!this.context) this.initialize();
    const context = this.context!;
    const active = !this.active;
    if (active) {
      await context.resume();
      if (context.state !== 'running') throw new Error('Audio context is suspended');
      this.active = true;
      this.output!.gain.cancelScheduledValues(context.currentTime);
      this.output!.gain.setTargetAtTime(0.16, context.currentTime, 0.6);
      this.playNote();
      this.timer = window.setInterval(() => this.playNote(), 1500);
    } else {
      this.active = false;
      this.output!.gain.cancelScheduledValues(context.currentTime);
      this.output!.gain.setTargetAtTime(0, context.currentTime, 0.18);
      if (this.timer !== null) window.clearInterval(this.timer);
      this.timer = null;
    }
    return active;
  }

  private initialize() {
    const context = new AudioContext();
    this.context = context;
    const output = context.createGain();
    output.gain.value = 0;
    output.connect(context.destination);
    this.output = output;

    const reverb = context.createConvolver();
    const length = context.sampleRate * 4;
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 3.5) * 0.45;
    }
    reverb.buffer = impulse;
    const wet = context.createGain();
    wet.gain.value = 0.42;
    reverb.connect(wet).connect(output);
    this.reverb = reverb;
  }

  private reverb: ConvolverNode | null = null;

  private playNote() {
    if (!this.active || this.context?.state !== 'running') return;
    const context = this.context;
    const notes = [220, 329.63, 440, 293.66, 261.63, 392, 329.63, 293.66];
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = notes[this.step++ % notes.length];
    const now = context.currentTime;
    envelope.gain.setValueAtTime(0, now);
    envelope.gain.linearRampToValueAtTime(0.32, now + 0.35);
    envelope.gain.exponentialRampToValueAtTime(0.001, now + 4.5);
    oscillator.connect(envelope);
    envelope.connect(this.output!);
    envelope.connect(this.reverb!);
    oscillator.start(now);
    oscillator.stop(now + 4.6);
    oscillator.onended = () => { oscillator.disconnect(); envelope.disconnect(); };
  }

  setPageVisible(visible: boolean) {
    if (!this.context || !this.active) return;
    if (visible) void this.context.resume().catch(() => undefined);
    else void this.context.suspend();
  }

  dispose() {
    if (this.timer !== null) window.clearInterval(this.timer);
    if (this.context) void this.context.close();
  }
}

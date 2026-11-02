/** A monochrome point-cloud sound field, rendered only while it is in view. */
export class SoundField {
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private frame = 0;
  private visible = false;
  private resting = false;
  private reduced: MediaQueryList;
  private resizeObserver: ResizeObserver;
  private observer: IntersectionObserver;
  private pointer = { x: 0, y: 0 };

  constructor(canvas: HTMLCanvasElement, reduced: MediaQueryList) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d')!;
    this.reduced = reduced;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.observer = new IntersectionObserver(([entry]) => {
      this.visible = entry.isIntersecting;
      this.startOrStop();
    });
    this.observer.observe(canvas);
    reduced.addEventListener('change', this.startOrStop);
    document.addEventListener('visibilitychange', this.startOrStop);
    canvas.parentElement!.addEventListener('pointermove', this.onPointer, { passive: true });
    this.resize();
  }

  private onPointer = (event: PointerEvent) => {
    const bounds = this.canvas.getBoundingClientRect();
    this.pointer.x = (event.clientX - bounds.left) / bounds.width - 0.5;
    this.pointer.y = (event.clientY - bounds.top) / bounds.height - 0.5;
  };

  private resize() {
    this.width = this.canvas.clientWidth;
    this.height = this.canvas.clientHeight;
    const pixelRatio = Math.min(window.devicePixelRatio, 1.6);
    this.canvas.width = Math.round(this.width * pixelRatio);
    this.canvas.height = Math.round(this.height * pixelRatio);
    this.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.draw(performance.now());
  }

  private startOrStop = () => {
    cancelAnimationFrame(this.frame);
    if (this.visible && !document.hidden && !this.reduced.matches) this.frame = requestAnimationFrame(this.tick);
    else this.drawStatic();
  };

  private tick = (time: number) => {
    this.draw(time);
    this.frame = requestAnimationFrame(this.tick);
  };

  private draw(time: number) {
    const ctx = this.context;
    ctx.clearRect(0, 0, this.width, this.height);
    const t = this.reduced.matches ? 0 : time * 0.00014;
    const centerX = this.width * 0.5;
    const centerY = this.height * 0.49;
    const base = Math.min(this.width * 0.25, this.height * 0.46);
    const rows = this.width < 700 ? 26 : 36;
    const columns = this.width < 700 ? 80 : 120;
    const driftX = this.reduced.matches ? 0 : this.pointer.x * 15;
    const driftY = this.reduced.matches ? 0 : this.pointer.y * 12;
    for (let row = 0; row < rows; row++) {
      const radius = base + row * (this.width < 700 ? 4.3 : 5.2);
      const opacity = (1 - row / rows) * (this.resting ? 0.22 : 0.29);
      ctx.fillStyle = `rgba(237, 237, 229, ${opacity})`;
      ctx.beginPath();
      for (let column = 0; column < columns; column++) {
        const angle = column / columns * Math.PI * 2;
        const ripple = Math.sin(angle * 3 + t + row * 0.17) * 11 + Math.sin(angle * 7 - t * 1.4 + row * 0.12) * 5;
        const x = centerX + Math.cos(angle) * (radius + ripple) * 1.43 + driftX;
        const y = centerY + Math.sin(angle) * (radius + ripple) * 0.62 + driftY;
        const dot = row % 3 === 0 ? 0.9 : 0.55;
        ctx.moveTo(x + dot, y);
        ctx.arc(x, y, dot, 0, Math.PI * 2);
      }
      ctx.fill();
    }
  }

  setResting(resting: boolean) { this.resting = resting; this.draw(performance.now()); }
  drawStatic() { this.draw(0); }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.observer.disconnect();
    this.reduced.removeEventListener('change', this.startOrStop);
    document.removeEventListener('visibilitychange', this.startOrStop);
    this.canvas.parentElement!.removeEventListener('pointermove', this.onPointer);
  }
}

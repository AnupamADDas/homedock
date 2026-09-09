/**
 * High-performance, zero-dependency HTML5 Canvas line/area chart renderer.
 */

export class SparklineChart {
  constructor(canvasElement, options = {}) {
    this.canvas = canvasElement;
    this.ctx = canvasElement.getContext("2d");
    this.options = Object.assign({
      color: "#38bdf8",
      fillColor: "rgba(56, 189, 248, 0.15)",
      secondaryColor: "#10b981",
      secondaryFillColor: "rgba(16, 185, 129, 0.15)",
      maxVal: 100,
      autoScale: false,
      lineWidth: 2,
    }, options);
    
    this.width = 0;
    this.height = 0;
    this._resizeObserver = new ResizeObserver(() => this.resize());
    if (this.canvas.parentElement) {
      this._resizeObserver.observe(this.canvas.parentElement);
    }
    this.resize();
  }

  resize() {
    const parent = this.canvas.parentElement;
    const rect = parent ? parent.getBoundingClientRect() : this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(rect.width) || (parent ? parent.clientWidth : 300) || 300;
    const h = Math.floor(rect.height) || (parent ? parent.clientHeight : 70) || 70;

    if (w <= 0 || h <= 0) return;

    this.width = w;
    this.height = h;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(dataSeries, secondarySeries = null) {
    if (!this.width || !this.height || this.width < 10) {
      this.resize();
    }
    const { ctx, width, height, options } = this;
    if (!width || !height) return;

    ctx.clearRect(0, 0, width, height);

    // Draw faint gridlines
    ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, height * 0.5);
    ctx.lineTo(width, height * 0.5);
    ctx.moveTo(0, height - 1);
    ctx.lineTo(width, height - 1);
    ctx.stroke();

    if (!dataSeries || dataSeries.length === 0) return;

    // If only 1 data point, duplicate to form line
    let primary = dataSeries;
    if (primary.length === 1) {
      primary = [primary[0], primary[0]];
    }

    let secondary = secondarySeries;
    if (secondary && secondary.length === 1) {
      secondary = [secondary[0], secondary[0]];
    }

    // Determine scale
    let max = options.maxVal;
    if (options.autoScale) {
      const allVals = primary.map(d => d.v || 0);
      if (secondary) {
        allVals.push(...secondary.map(d => d.v || 0));
      }
      max = Math.max(...allVals, 1024); // at least 1 KB scale
      max = max * 1.15; // 15% headroom
    }

    // Draw secondary series if provided (e.g. Upload TX)
    if (secondary && secondary.length >= 2) {
      this._drawLine(secondary, options.secondaryColor, options.secondaryFillColor, max);
    }

    // Draw primary series (e.g. Download RX or CPU)
    this._drawLine(primary, options.color, options.fillColor, max);
  }

  _drawLine(series, strokeColor, fillColor, max) {
    const { ctx, width, height, options } = this;
    const step = width / (series.length - 1);

    ctx.beginPath();
    const startY = Math.min(Math.max(height - (series[0].v / max) * height, 2), height - 2);
    ctx.moveTo(0, startY);

    for (let i = 1; i < series.length; i++) {
      const x = i * step;
      const y = Math.min(Math.max(height - (series[i].v / max) * height, 2), height - 2);
      ctx.lineTo(x, y);
    }

    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = options.lineWidth;
    ctx.stroke();

    // Fill area under curve
    if (fillColor) {
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.fillStyle = fillColor;
      ctx.fill();
    }
  }

  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
    }
  }
}

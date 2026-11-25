// Sticker de calibración: un contador de milisegundos con un pitido en cada segundo.
// Al oír el pitido en el celular, el número que se ve es el desfase (ver README).

const SECONDS = 3;
const BEEP_MS = 60;

export function calibrationSource() {
  return {
    kind: "synthetic",
    w: 512, h: 512, duration: SECONDS, offset: 0,
    draw(ctx, t) {
      const frac = t - Math.floor(t);
      const step = Math.floor(frac * 20) * 50; // 0, 50, … 950
      const shown = step <= 500 ? step : step - 1000; // −450 … 500: el signo indica adelanto/retraso
      ctx.fillStyle = "#0b0b10";
      ctx.fillRect(0, 0, 512, 512);
      // destello en el instante del pitido
      if (frac < BEEP_MS / 1000) {
        ctx.fillStyle = "#f0a30a";
        ctx.fillRect(0, 0, 512, 512);
      }
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 150px system-ui, sans-serif";
      ctx.fillText(String(shown), 256, 230);
      ctx.font = "bold 34px system-ui, sans-serif";
      ctx.fillStyle = "#fcd34d";
      ctx.fillText("ms", 256, 330);
      ctx.font = "26px system-ui, sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.fillText("Al oír el pitido, mira el número", 256, 50);
      // barra de progreso dentro del segundo
      ctx.fillStyle = "#2a2f3a";
      ctx.fillRect(56, 420, 400, 22);
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(56, 420, 400 * frac, 22);
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(254, 410, 4, 42); // marca del 500
    },
  };
}

export function calibrationAudio() {
  const SR = 48000;
  const buf = new AudioBuffer({ length: SECONDS * SR, numberOfChannels: 1, sampleRate: SR });
  const d = buf.getChannelData(0);
  for (let s = 0; s < SECONDS; s++) {
    const a = s * SR;
    const n = Math.round((BEEP_MS / 1000) * SR);
    for (let i = 0; i < n; i++) d[a + i] = 0.8 * Math.sin((2 * Math.PI * 1000 * i) / SR);
  }
  return { buffer: buf, start: 0, duration: SECONDS, gain: 1 };
}

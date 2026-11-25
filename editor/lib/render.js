// Geometría del encuadre: rotación, volteo y recorte, todo en el espacio "orientado"
// (el cuadro ya rotado), con el recorte en píxeles de ese espacio.

export function orientedSize(w, h, rot) {
  return rot % 180 ? [h, w] : [w, h];
}

/**
 * Dibuja `src` (video, ImageBitmap…) en ctx aplicando orientación y recorte.
 * El recorte se escala para caber en outW×outH, centrado; lo que sobra queda transparente.
 */
export function drawFrame(ctx, src, srcW, srcH, tf, crop, outW, outH) {
  const [OW, OH] = orientedSize(srcW, srcH, tf.rot);
  const c = crop || { x: 0, y: 0, w: OW, h: OH };
  const s = Math.min(outW / c.w, outH / c.h);
  const dw = c.w * s;
  const dh = c.h * s;
  const dx = (outW - dw) / 2;
  const dy = (outH - dh) / 2;
  ctx.clearRect(0, 0, outW, outH);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.beginPath();
  ctx.rect(dx, dy, dw, dh);
  ctx.clip();
  ctx.translate(dx, dy);
  ctx.scale(s, s);
  ctx.translate(-c.x, -c.y);
  ctx.translate(OW / 2, OH / 2);
  ctx.scale(tf.flipH ? -1 : 1, tf.flipV ? -1 : 1); // volteo en el espacio orientado (como se ve)
  ctx.rotate((tf.rot * Math.PI) / 180);
  ctx.drawImage(src, -srcW / 2, -srcH / 2, srcW, srcH);
  ctx.restore();
}

/** Recorte cuadrado más grande posible, centrado. */
export function maxSquare(OW, OH) {
  const side = Math.min(OW, OH);
  return { x: (OW - side) / 2, y: (OH - side) / 2, w: side, h: side };
}

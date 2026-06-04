import React, { useRef, useEffect } from 'react';

interface Props {
  data: number[];
  color?: string;
  width?: number;
  height?: number;
}

export const TelemetrySparkline: React.FC<Props> = ({ 
  data, 
  color = '#3b82f6', 
  width = 120, 
  height = 40 
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || data.length < 2) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, width, height);
    
    // Calculate bounds
    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;

    // Draw line
    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    const step = width / (data.length - 1);
    data.forEach((val, i) => {
      const x = i * step;
      const y = height - ((val - min) / range) * (height - 4) - 2;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // Fill area
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, `${color}44`);
    grad.addColorStop(1, `${color}00`);
    ctx.fillStyle = grad;
    ctx.fill();

  }, [data, color, width, height]);

  return (
    <canvas 
      ref={canvasRef} 
      style={{ width, height }} 
      className="opacity-80 transition-opacity hover:opacity-100"
    />
  );
};

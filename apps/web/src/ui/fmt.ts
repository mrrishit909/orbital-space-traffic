const SUP: Record<string, string> = { "-": "⁻", "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹" };
/** 3.0 × 10⁻⁴ */
export function pc(x: number) {
  if (x === 0) return "0";
  if (x >= 0.01) return x.toFixed(3);
  const [m, e] = x.toExponential(1).split("e");
  return `${m} × 10${String(+e).split("").map((c) => SUP[c]).join("")}`;
}
export const utc = (t: number) => new Date(t).toISOString().slice(5, 19).replace("T", " ").replace(/^(\d\d)-(\d\d)/, (_, mo, d) => `${d} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][+mo - 1]}`) + " UTC";
export const hhmm = (t: number) => new Date(t).toISOString().slice(11, 16);
export const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 2)} km` : `${Math.round(m)} m`);
export const n = (x: number) => x.toLocaleString("en-US");
export const cms = (ms: number) => `${(ms * 100).toFixed(2)} cm/s`;
export const riskText = { high: "High", medium: "Medium", low: "Low" } as const;
export const riskIcon = { high: "▲", medium: "◆", low: "●" } as const;

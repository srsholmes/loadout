import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { interpolateCurve, type FanCurvePoint } from "../lib/fan-curves";
import { CURVE_TEMP_MAX, CURVE_TEMP_MIN } from "../lib/custom-curve";

/**
 * Graph editor for a custom fan curve — temperature (x) vs fan duty (y).
 *
 * Pure presentation + pointer interaction; it owns no curve state. The
 * parent passes `points` and gets edits back through `onChangePoint`
 * (live, every drag tick) and `onCommit` (pointer release — the cue to
 * persist). Gamepad users edit the selected point through the sliders the
 * parent renders alongside this graph, so the SVG is pointer-only: tap a
 * node to select it, drag to move it. `onSelectPoint` keeps the parent's
 * selection in sync with taps here.
 *
 * The flat segments drawn from the plot edges to the first/last node
 * mirror interpolateCurve's clamp behaviour (hold the endpoint percent
 * beyond the curve's temperature range) so the rendered line matches what
 * the backend actually does.
 */

// Internal SVG coordinate space. The element scales to its container via
// viewBox; these are unitless design coordinates, not pixels.
const W = 320;
const H = 196;
const PAD_L = 30; // room for the % axis labels
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 22; // room for the °C axis labels

const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

const TEMP_TICKS = [20, 40, 60, 80, 100];
const PCT_TICKS = [0, 25, 50, 75, 100];

const tempToX = (tempC: number) =>
  PAD_L +
  ((tempC - CURVE_TEMP_MIN) / (CURVE_TEMP_MAX - CURVE_TEMP_MIN)) * PLOT_W;
const pctToY = (percent: number) => PAD_T + (1 - percent / 100) * PLOT_H;

export interface FanCurveGraphProps {
  points: FanCurvePoint[];
  /** Index of the node the parent's sliders are editing (highlighted). */
  selectedIndex?: number | null;
  /** Fired when a node is tapped or dragged — keep parent selection in sync. */
  onSelectPoint?: (index: number) => void;
  /** Live edit during a drag. Parent clamps/sanitises as it sees fit. */
  onChangePoint?: (index: number, point: FanCurvePoint) => void;
  /** Pointer released after a drag — the cue to persist. */
  onCommit?: () => void;
  /** Current CPU/SoC temperature, drawn as a live operating-point marker. */
  currentTempC?: number | null;
  /** When false, nodes can't be dragged/selected — used to *visualise* a
   *  read-only preset curve. Defaults to true (the custom-curve editor). */
  editable?: boolean;
}

export function FanCurveGraph({
  points,
  selectedIndex = null,
  onSelectPoint,
  onChangePoint,
  onCommit,
  currentTempC,
  editable = true,
}: FanCurveGraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragIndex = useRef<number | null>(null);

  // Map a pointer event's client position into a clamped {tempC, percent}.
  // Temperature is bounded by the node's neighbours (with a 1 °C gap) so a
  // drag can never reorder the curve out from under the interpolation.
  const eventToPoint = (
    e: ReactPointerEvent<Element>,
    index: number,
  ): FanCurvePoint => {
    const svg = svgRef.current;
    const rect = svg?.getBoundingClientRect();
    const width = rect?.width || 1;
    const height = rect?.height || 1;
    const svgX = ((e.clientX - (rect?.left ?? 0)) / width) * W;
    const svgY = ((e.clientY - (rect?.top ?? 0)) / height) * H;

    const fracX = (svgX - PAD_L) / PLOT_W;
    const fracY = (svgY - PAD_T) / PLOT_H;

    const rawTemp =
      CURVE_TEMP_MIN + fracX * (CURVE_TEMP_MAX - CURVE_TEMP_MIN);
    const rawPct = (1 - fracY) * 100;

    const minTemp = index > 0 ? points[index - 1].tempC + 1 : CURVE_TEMP_MIN;
    const maxTemp =
      index < points.length - 1
        ? points[index + 1].tempC - 1
        : CURVE_TEMP_MAX;

    const tempC = Math.max(minTemp, Math.min(maxTemp, Math.round(rawTemp)));
    const percent = Math.max(0, Math.min(100, Math.round(rawPct)));
    return { tempC, percent };
  };

  const handlePointerDown = (
    e: ReactPointerEvent<Element>,
    index: number,
  ) => {
    onSelectPoint?.(index);
    if (!editable) return;
    e.preventDefault();
    dragIndex.current = index;
    svgRef.current?.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const index = dragIndex.current;
    if (index === null || !editable) return;
    onChangePoint?.(index, eventToPoint(e, index));
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (dragIndex.current === null) return;
    dragIndex.current = null;
    svgRef.current?.releasePointerCapture?.(e.pointerId);
    onCommit?.();
  };

  // Curve path: flat hold from the left edge to the first node, through
  // every node, then a flat hold out to the right edge.
  const first = points[0];
  const last = points[points.length - 1];
  const linePath =
    `M ${PAD_L} ${pctToY(first.percent)} ` +
    points.map((p) => `L ${tempToX(p.tempC)} ${pctToY(p.percent)}`).join(" ") +
    ` L ${W - PAD_R} ${pctToY(last.percent)}`;
  const areaPath =
    `${linePath} L ${W - PAD_R} ${PAD_T + PLOT_H} L ${PAD_L} ${PAD_T + PLOT_H} Z`;

  // Live operating point: where the current temperature lands on the curve.
  const liveTemp =
    typeof currentTempC === "number" && currentTempC > 0
      ? Math.max(CURVE_TEMP_MIN, Math.min(CURVE_TEMP_MAX, currentTempC))
      : null;
  const livePct =
    liveTemp !== null ? interpolateCurve(points, liveTemp) : null;

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full select-none touch-none"
      style={{ height: "auto", display: "block" }}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      role="img"
      aria-label="Fan curve graph"
    >
      {/* Grid + axis labels */}
      {PCT_TICKS.map((pct) => {
        const y = pctToY(pct);
        return (
          <g key={`p${pct}`}>
            <line
              x1={PAD_L}
              y1={y}
              x2={W - PAD_R}
              y2={y}
              stroke="var(--line, rgba(255,255,255,0.10))"
              strokeWidth={0.75}
            />
            <text
              x={PAD_L - 5}
              y={y + 3}
              textAnchor="end"
              fontSize={8}
              fill="var(--fg-2, rgba(255,255,255,0.45))"
            >
              {pct}
            </text>
          </g>
        );
      })}
      {TEMP_TICKS.map((temp) => {
        const x = tempToX(temp);
        return (
          <g key={`t${temp}`}>
            <line
              x1={x}
              y1={PAD_T}
              x2={x}
              y2={PAD_T + PLOT_H}
              stroke="var(--line, rgba(255,255,255,0.10))"
              strokeWidth={0.75}
            />
            <text
              x={x}
              y={H - 7}
              textAnchor="middle"
              fontSize={8}
              fill="var(--fg-2, rgba(255,255,255,0.45))"
            >
              {temp}°
            </text>
          </g>
        );
      })}

      {/* Area + curve line */}
      <path d={areaPath} fill="var(--accent, #4ade80)" opacity={0.12} />
      <path
        d={linePath}
        fill="none"
        stroke="var(--accent, #4ade80)"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {/* Live operating-point marker */}
      {liveTemp !== null && livePct !== null && (
        <g>
          <line
            x1={tempToX(liveTemp)}
            y1={PAD_T}
            x2={tempToX(liveTemp)}
            y2={PAD_T + PLOT_H}
            stroke="var(--color-warning, #fbbf24)"
            strokeWidth={1}
            strokeDasharray="3 3"
            opacity={0.8}
          />
          <circle
            cx={tempToX(liveTemp)}
            cy={pctToY(livePct)}
            r={3}
            fill="var(--color-warning, #fbbf24)"
          />
        </g>
      )}

      {/* Editable control nodes. Larger invisible hit-target behind each
          visible node so they're reachable on a touchscreen. */}
      {points.map((p, i) => {
        const cx = tempToX(p.tempC);
        const cy = pctToY(p.percent);
        const selected = i === selectedIndex;
        return (
          <g key={i}>
            <circle
              cx={cx}
              cy={cy}
              r={10}
              fill="transparent"
              style={{ cursor: editable ? "grab" : "default" }}
              onPointerDown={(e) => handlePointerDown(e, i)}
            />
            <circle
              cx={cx}
              cy={cy}
              r={selected ? 5.5 : 4}
              fill={selected ? "var(--accent, #4ade80)" : "var(--bg-inset, #1e1e1e)"}
              stroke="var(--accent, #4ade80)"
              strokeWidth={2}
              pointerEvents="none"
            />
          </g>
        );
      })}
    </svg>
  );
}

import { Tooltip } from 'antd';
import { QuestionCircleOutlined } from '@ant-design/icons';
import { convertUnit } from '../shared/units.ts';
import type { RecipeEstimate } from './recipeCalculations.ts';

function EstimateTile({ label, value, help, sources }: { label: string; value: string | null; help: string[]; sources: string[] }) {
  return <div><span className="recipe-estimate-label">{label}
    <Tooltip title={<div>{[...sources, ...help].map((line, index) => <div key={index}>{line}</div>)}</div>}
      trigger={['hover', 'focus', 'click']}>
      <button type="button" className="recipe-estimate-help" aria-label={`${label} calculation sources`}>
        <QuestionCircleOutlined /></button>
    </Tooltip></span><strong>{value ?? '—'}</strong></div>;
}

export function CalculationsCard({ estimate, volumeUnit, showColor, label }: {
  estimate: RecipeEstimate; volumeUnit: string; showColor: boolean; label: string;
}) {
  return <section className="recipe-estimates" aria-label={label}>
    <h3>Details</h3>
    <div className="recipe-estimate-grid">
      <EstimateTile label="Batch size" value={estimate.targetLiters == null ? null
        : `${Number((convertUnit(estimate.targetLiters, 'L', volumeUnit) || 0).toFixed(2))} ${volumeUnit}`}
        help={estimate.unavailable.targetLiters} sources={estimate.sources.targetLiters} />
      <EstimateTile label="Expected OG" value={estimate.originalGravity?.toFixed(3) ?? null}
        help={estimate.unavailable.originalGravity} sources={estimate.sources.originalGravity} />
      <EstimateTile label="Expected FG" value={estimate.finalGravity == null ? null
        : `${estimate.usedAppYeastAttenuation ? '≈' : ''}${estimate.finalGravity.toFixed(3)}`}
        help={estimate.unavailable.finalGravity} sources={estimate.sources.finalGravity} />
      <EstimateTile label="Expected ABV" value={estimate.abvPct == null ? null
        : `${estimate.usedAppYeastAttenuation ? '≈' : ''}${estimate.abvPct.toFixed(1)}%`}
        help={estimate.unavailable.abvPct} sources={estimate.sources.abvPct} />
      {showColor && <EstimateTile label="Estimated color"
        value={estimate.colorSrm == null ? null : `${estimate.colorSrm.toFixed(1)} SRM`}
        help={estimate.unavailable.colorSrm} sources={estimate.sources.colorSrm} />}
    </div>
  </section>;
}

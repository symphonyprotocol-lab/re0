'use client';

import { PRODUCT_SHEET_LIMITS, SHARE_STYLES, type ProductSheet, type ShareStyle } from '@/lib/domain/share-style';
import { useI18n } from '@/i18n/client';
import { fill } from '@/i18n/format';
import { Field } from '@/components/rees/ree-fields';
import { PIcon } from '@/components/rees/proto-icon';

/**
 * 分享页样式 in a Ree's settings (lib/domain/share-style.ts): the share
 * page's two layouts, each with a sketch of its first screen, and, for the
 * product style, the sheet the owner types -- shown on the page as typed.
 */
export function ShareStyleFields({ style, sheet, onChange, shareHref }: {
  style: ShareStyle;
  sheet: ProductSheet;
  onChange: (patch: { shareStyle?: ShareStyle; productSheet?: ProductSheet }) => void;
  /** The share page, when it is live. */
  shareHref: string | null;
}) {
  const { t } = useI18n();
  const v = t.reeSetup.shareStyle;
  const p = v.product;
  const L = PRODUCT_SHEET_LIMITS;
  const set = (patch: Partial<ProductSheet>) => onChange({ productSheet: { ...sheet, ...patch } });
  return (
    <>
      <p className="share-style-lede">{v.lede}</p>
      <div className="share-style-options" role="radiogroup" aria-label={v.title}>
        {SHARE_STYLES.map((option) => (
          <label key={option}>
            <input type="radio" name="shareStyle" value={option} checked={style === option} onChange={() => onChange({ shareStyle: option })} />
            <span className={`share-style-sketch is-${option}`} aria-hidden="true">
              {option === 'product' ? (
                <>
                  <i className="k" />
                  <i className="h" />
                  <i className="l" />
                  <i className="b" />
                  <i className="photo" />
                  <i className="f" />
                </>
              ) : (
                <>
                  <i className="a" />
                  <i className="h" />
                  <i className="l" />
                  <i className="b" />
                  <i className="qa" />
                  <i className="f" />
                </>
              )}
            </span>
            <span className="share-style-text">
              <strong>{v.styles[option].name}</strong>
              <small>{v.styles[option].body}</small>
            </span>
          </label>
        ))}
      </div>
      {shareHref && (
        <a href={shareHref} target="_blank" rel="noopener noreferrer" className="share-style-open">
          <PIcon name="external" />
          {v.open}
        </a>
      )}
      {style === 'product' && (
        <div className="share-style-product">
          <h3>{p.heading}</h3>
          <p className="form-hint">{p.hint}</p>
          <div className="share-style-row">
            <Field id="edit-product-name" label={p.name} hint={p.nameHint}>
              <input id="edit-product-name" name="productName" maxLength={L.product} value={sheet.product} onChange={(event) => set({ product: event.target.value })} />
            </Field>
            <Field id="edit-product-line" label={p.line}>
              <input id="edit-product-line" name="productLine" maxLength={L.line} placeholder={p.linePlaceholder} value={sheet.line} onChange={(event) => set({ line: event.target.value })} />
            </Field>
          </div>
          <div className="share-style-row">
            <Field id="edit-product-maker" label={p.maker}>
              <input id="edit-product-maker" name="productMaker" maxLength={L.maker} value={sheet.maker} onChange={(event) => set({ maker: event.target.value })} />
            </Field>
            <Field id="edit-product-link" label={p.link} hint={p.linkHint}>
              <input id="edit-product-link" name="productLink" type="url" inputMode="url" maxLength={L.link} placeholder="https://" value={sheet.link} onChange={(event) => set({ link: event.target.value })} />
            </Field>
          </div>

          <p className="field-label">{p.features}</p>
          <small className="share-style-hint">{p.featuresHint}</small>
          <ol className="share-style-list">
            {sheet.features.map((feature, index) => (
              <li key={index} className="share-style-feature">
                <input aria-label={fill(p.featureTitle, { n: index + 1 })} placeholder={fill(p.featureTitle, { n: index + 1 })} maxLength={L.featureTitle} value={feature.title} onChange={(event) => set({ features: sheet.features.map((row, at) => (at === index ? { ...row, title: event.target.value } : row)) })} />
                <textarea aria-label={fill(p.featureBody, { n: index + 1 })} placeholder={fill(p.featureBody, { n: index + 1 })} maxLength={L.featureBody} rows={2} value={feature.body} onChange={(event) => set({ features: sheet.features.map((row, at) => (at === index ? { ...row, body: event.target.value } : row)) })} />
                <button type="button" className="btn ghost sm" aria-label={`${p.remove} ${index + 1}`} onClick={() => set({ features: sheet.features.filter((_, at) => at !== index) })}>
                  <PIcon name="trash" />
                </button>
              </li>
            ))}
          </ol>
          {sheet.features.length < L.features && (
            <button type="button" className="btn secondary sm" onClick={() => set({ features: [...sheet.features, { title: '', body: '' }] })}>
              <PIcon name="plus" />
              {p.addFeature}
            </button>
          )}

          <p className="field-label mt-6">{p.specs}</p>
          <small className="share-style-hint">{p.specsHint}</small>
          <ol className="share-style-list">
            {sheet.specs.map((spec, index) => (
              <li key={index} className="share-style-spec">
                <input aria-label={fill(p.specLabel, { n: index + 1 })} placeholder={fill(p.specLabel, { n: index + 1 })} maxLength={L.specLabel} value={spec.label} onChange={(event) => set({ specs: sheet.specs.map((row, at) => (at === index ? { ...row, label: event.target.value } : row)) })} />
                <input aria-label={fill(p.specValue, { n: index + 1 })} placeholder={fill(p.specValue, { n: index + 1 })} maxLength={L.specValue} value={spec.value} onChange={(event) => set({ specs: sheet.specs.map((row, at) => (at === index ? { ...row, value: event.target.value } : row)) })} />
                <button type="button" className="btn ghost sm" aria-label={`${p.remove} ${index + 1}`} onClick={() => set({ specs: sheet.specs.filter((_, at) => at !== index) })}>
                  <PIcon name="trash" />
                </button>
              </li>
            ))}
          </ol>
          {sheet.specs.length < L.specs && (
            <button type="button" className="btn secondary sm" onClick={() => set({ specs: [...sheet.specs, { label: '', value: '' }] })}>
              <PIcon name="plus" />
              {p.addSpec}
            </button>
          )}
        </div>
      )}
    </>
  );
}

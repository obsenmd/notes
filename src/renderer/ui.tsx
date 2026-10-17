import { createElement, useLayoutEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import { setIcon } from "../compat/utilities";

type DataAttributes = { [key: `data-${string}`]: string | number | boolean | undefined };
type ElementProps = HTMLAttributes<HTMLElement> & DataAttributes;

/** An element whose only child is an icon, as the reference renders them. */
export function IconEl({ icon, tag = "div", ...props }: ElementProps & { icon: string; tag?: string }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => { if (ref.current) setIcon(ref.current, icon); }, [icon]);
  return createElement(tag, { ...props, ref });
}

export const cx = (...names: Array<string | false | null | undefined>) => names.filter(Boolean).join(" ");

export function ClickableIcon({ icon, label, className, tag = "div", ...props }: ElementProps & { icon: string; label?: string; tag?: string }) {
  return <IconEl tag={tag} icon={icon} className={cx("clickable-icon", className)} aria-label={label} {...props} />;
}

/** The reference switch: a label that carries state in `is-enabled`. */
export function Toggle({ value, onChange, disabled, label }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean; label?: string }) {
  return <label className={cx("checkbox-container", value && "is-enabled", disabled && "is-disabled")} tabIndex={0} aria-label={label}
    onClick={event => { event.preventDefault(); if (!disabled) onChange(!value); }}
    onKeyDown={event => { if ((event.key === " " || event.key === "Enter") && !disabled) { event.preventDefault(); onChange(!value); } }}>
    <input type="checkbox" tabIndex={-1} checked={value} readOnly />
  </label>;
}

export function SearchInput({ value, onChange, placeholder, className, clearLabel, onKeyDown, autoFocus, children, style }: {
  value: string; onChange: (value: string) => void; placeholder?: string; className?: string; clearLabel?: string;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void; autoFocus?: boolean; children?: ReactNode; style?: CSSProperties;
}) {
  return <div className={cx("search-input-container", className)} style={style}>
    <input type="search" enterKeyHint="search" spellCheck={false} placeholder={placeholder} value={value} autoFocus={autoFocus}
      onChange={event => onChange(event.target.value)} onKeyDown={onKeyDown} />
    <div className="search-input-clear-button" aria-label={clearLabel} style={value ? undefined : { display: "none" }} onClick={() => onChange("")} />
    {children}
  </div>;
}

export function Slider({ value, min, max, step, onChange, format }: { value: number; min: number; max: number; step: number | "any"; onChange: (value: number) => void; format?: (value: number) => string }) {
  const ratio = max === min ? 0 : (value - min) / (max - min);
  return <>
    {format && <span className="slider-value">{format(value)}</span>}
    <input className="slider" type="range" min={min} max={max} step={step} value={value}
      style={{ "--slider-fill-ratio": String(Math.max(0, Math.min(1, ratio))) } as CSSProperties}
      onChange={event => onChange(Number(event.target.value))} />
  </>;
}

/** A row from the reference settings system. */
export function SettingItem({ name, description, children, className, heading, nameLabel, noInfo, style }: {
  name?: ReactNode; description?: ReactNode; children?: ReactNode; className?: string; heading?: boolean; nameLabel?: string; noInfo?: boolean; style?: CSSProperties;
}) {
  return <div className={cx("setting-item", heading && "setting-item-heading", className)} tabIndex={-1} style={style}>
    <div className="setting-item-info" style={noInfo ? { display: "none" } : undefined}>
      <div className="setting-item-name" aria-label={nameLabel}>{name}</div>
      <div className="setting-item-description">{description}</div>
    </div>
    <div className="setting-item-control">{children}</div>
  </div>;
}

export function Dropdown<T extends string>({ value, options, onChange, label, autoWidth }: { value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label?: string; autoWidth?: boolean }) {
  const input = useRef<HTMLSelectElement>(null), measure = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => { if (autoWidth && input.current && measure.current?.offsetWidth) input.current.style.setProperty("--dropdown-fitted-width", `${measure.current.offsetWidth}px`); });
  return <><select ref={input} className="dropdown" value={value} aria-label={label} onChange={event => onChange(event.target.value as T)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>{autoWidth && <select ref={measure} className="dropdown is-measuring" tabIndex={-1} aria-hidden="true"><option>{options.find(option => option.value === value)?.label}</option></select>}</>;
}

/** Collapsible tree row with the reference triangle indicator. */
export function CollapseIcon({ collapsed, className }: { collapsed: boolean; className?: string }) {
  return <IconEl icon="right-triangle" className={cx("tree-item-icon collapse-icon", collapsed && "is-collapsed", className)} />;
}

export function useForceUpdate(): () => void {
  const [, setTick] = useState(0);
  return () => setTick(tick => tick + 1);
}

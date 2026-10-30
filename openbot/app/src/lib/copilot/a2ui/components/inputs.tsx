import type { ComponentContext } from "@a2ui/web_core/v0_9";
import {
  ButtonApi,
  CheckBoxApi,
  ChoicePickerApi,
  DateTimeInputApi,
  SliderApi,
  TextFieldApi,
} from "@a2ui/web_core/v0_9/basic_catalog";
import { type ChangeEvent, type CSSProperties, useId, useState } from "react";
import { createReactComponent } from "../adapter";
import type { ComponentViewProps } from "../types";

const FIELD_STYLE: CSSProperties = { width: "100%", padding: "0.4rem 0.6rem" };
const ERROR_STYLE: CSSProperties = {
  color: "var(--destructive, #b91c1c)",
  fontSize: "0.85em",
};

/** A payload binds a prop to the data model with `{ "path": "/x" }`, and only then can it be written. */
function isPathBinding(value: unknown): value is { path: string } {
  return typeof value === "object" && value !== null && "path" in value;
}

/**
 * Two-way binding for an input.
 *
 * When the payload bound the field to a data path, the write goes through the binder's setter and
 * the value shown is the one the data model now holds — which is what makes an action's `{ path }`
 * context see what the person typed. When the payload gave a plain literal instead, the write
 * stays local, because a field that silently refuses to change is worse than an unsaved one.
 */
function useFieldValue<T>(
  context: ComponentContext,
  bound: T,
  setBound: (next: T) => void,
) {
  const [draft, setDraft] = useState<T | undefined>(undefined);
  const writable = isPathBinding(context.componentModel.properties.value);
  const write = (next: T) => {
    if (writable) setBound(next);
    else setDraft(next);
  };
  return [writable ? bound : (draft ?? bound), write] as const;
}

const labelOf = (label: unknown): string | undefined =>
  typeof label === "string" && label.length > 0 ? label : undefined;

function ValidationError({ message }: { message?: string }) {
  if (!message) return null;
  return (
    <span role="alert" style={ERROR_STYLE}>
      {message}
    </span>
  );
}

/**
 * A Button whose whole job is to raise one action. The binder has already turned `action` into a
 * callable, and that callable resolves the action's `context` paths against the data model at click
 * time — so a field edited a moment ago is what gets sent, not what was sent with the payload.
 */
function ButtonView({
  props,
  buildChild,
}: ComponentViewProps<typeof ButtonApi>) {
  return (
    <>
      <button
        type="button"
        onClick={props.action}
        style={{ padding: "0.45rem 0.9rem" }}
      >
        {buildChild(props.child)}
      </button>
      <ValidationError message={props.validationErrors?.[0]} />
    </>
  );
}

function TextFieldView({
  props,
  context,
}: ComponentViewProps<typeof TextFieldApi>) {
  const id = useId();
  const label = labelOf(props.label);
  const [value, write] = useFieldValue<string>(
    context,
    String(props.value ?? ""),
    (next) => props.setValue(next),
  );
  const onChange = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => write(event.target.value);
  const error = props.validationErrors?.[0];
  const type =
    props.variant === "number"
      ? "number"
      : props.variant === "obscured"
        ? "password"
        : "text";
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      {props.variant === "longText" ? (
        <textarea
          id={id}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          rows={3}
          value={value}
          onChange={onChange}
          style={FIELD_STYLE}
        />
      ) : (
        <input
          id={id}
          type={type}
          aria-label={label}
          aria-invalid={error ? true : undefined}
          value={value}
          onChange={onChange}
          style={FIELD_STYLE}
        />
      )}
      <ValidationError message={error} />
    </div>
  );
}

function CheckBoxView({
  props,
  context,
}: ComponentViewProps<typeof CheckBoxApi>) {
  const id = useId();
  const label = labelOf(props.label);
  const [value, write] = useFieldValue<boolean>(
    context,
    Boolean(props.value),
    (next) => props.setValue(next),
  );
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        checked={value}
        onChange={(event) => write(event.target.checked)}
      />
      {label ? <label htmlFor={id}>{label}</label> : null}
      <ValidationError message={props.validationErrors?.[0]} />
    </div>
  );
}

/**
 * One choice out of a list, or several: `mutuallyExclusive` replaces the selection, the other
 * variant toggles. Both are drawn as checkboxes on purpose — `displayStyle: "chips"` changes the
 * look of a control whose behaviour must stay the same, not the behaviour itself.
 */
function ChoicePickerView({
  props,
  context,
}: ComponentViewProps<typeof ChoicePickerApi>) {
  const label = labelOf(props.label);
  const exclusive = props.variant === "mutuallyExclusive";
  const initial = Array.isArray(props.value) ? (props.value as string[]) : [];
  const [value, write] = useFieldValue<string[]>(context, initial, (next) =>
    props.setValue(next),
  );
  const options = Array.isArray(props.options) ? props.options : [];
  const toggle = (option: string) => {
    if (exclusive) return write([option]);
    write(
      value.includes(option)
        ? value.filter((selected) => selected !== option)
        : [...value, option],
    );
  };
  return (
    <fieldset
      aria-label={label}
      style={{
        border: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: "0.25rem",
      }}
    >
      {label ? <legend style={{ padding: 0 }}>{label}</legend> : null}
      {options.map((option) => {
        const optionLabel = String(option.label ?? option.value);
        return (
          <label
            key={option.value}
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
          >
            <input
              type="checkbox"
              checked={value.includes(option.value)}
              onChange={() => toggle(option.value)}
            />
            {optionLabel}
          </label>
        );
      })}
      <ValidationError message={props.validationErrors?.[0]} />
    </fieldset>
  );
}

function SliderView({ props, context }: ComponentViewProps<typeof SliderApi>) {
  const id = useId();
  const label = labelOf(props.label);
  const min = props.min ?? 0;
  const max = props.max ?? 100;
  const [value, write] = useFieldValue<number>(
    context,
    Number(props.value ?? min),
    (next) => props.setValue(next),
  );
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <input
        id={id}
        type="range"
        aria-label={label}
        min={min}
        max={max}
        value={value}
        onChange={(event) => write(Number(event.target.value))}
      />
      <span>{value}</span>
    </div>
  );
}

function DateTimeInputView({
  props,
  context,
}: ComponentViewProps<typeof DateTimeInputApi>) {
  const id = useId();
  const label = labelOf(props.label);
  const [value, write] = useFieldValue<string>(
    context,
    String(props.value ?? ""),
    (next) => props.setValue(next),
  );
  const type =
    props.enableDate && props.enableTime
      ? "datetime-local"
      : props.enableTime
        ? "time"
        : "date";
  return (
    <div style={{ display: "grid", gap: "0.25rem" }}>
      {label ? <label htmlFor={id}>{label}</label> : null}
      <input
        id={id}
        type={type}
        aria-label={label}
        min={typeof props.min === "string" ? props.min : undefined}
        max={typeof props.max === "string" ? props.max : undefined}
        value={value}
        onChange={(event) => write(event.target.value)}
        style={FIELD_STYLE}
      />
      <ValidationError message={props.validationErrors?.[0]} />
    </div>
  );
}

export const Button = createReactComponent(ButtonApi, ButtonView);
export const TextField = createReactComponent(TextFieldApi, TextFieldView);
export const CheckBox = createReactComponent(CheckBoxApi, CheckBoxView);
export const ChoicePicker = createReactComponent(
  ChoicePickerApi,
  ChoicePickerView,
);
export const Slider = createReactComponent(SliderApi, SliderView);
export const DateTimeInput = createReactComponent(
  DateTimeInputApi,
  DateTimeInputView,
);

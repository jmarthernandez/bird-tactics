// Tiny DOM helpers so UI code stays readable without a framework.

type Child = Node | string | null | undefined | false;
type Props = Record<string, unknown> & { class?: string; style?: string };

/** h("button", { class: "primary", onclick: fn }, "Click me") */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === "class") {
      el.className = String(value);
    } else if (key in el && key !== "style") {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** Replace all children of `el`. */
export function setChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren(...children.filter((c): c is Node | string => !!c));
}

let toastBox: HTMLElement | null = null;
/** Brief pop-up message in the corner. */
export function toast(text: string): void {
  if (!toastBox) {
    toastBox = h("div", { class: "toasts", "aria-live": "polite" });
    document.body.append(toastBox);
  }
  const t = h("div", { class: "toast" }, text);
  toastBox.append(t);
  setTimeout(() => t.classList.add("fade"), 3500);
  setTimeout(() => t.remove(), 4000);
}

export const SIDE_LABEL = { blue: "Blue", red: "Red" } as const;

/**
 * The sub-view switcher under a page's h1: a row of links driven by the
 * `?view=` param (the dashboard's existing query-param convention — full
 * loads, no client state). Client-safe: no server imports.
 */
export interface SubNavItem {
  key: string;
  label: string;
  href: string;
}

export function SubNav({ items, current }: { items: SubNavItem[]; current: string }) {
  return (
    <div class="chips subnav">
      {items.map((i) => (
        <a key={i.key} href={i.href} class={i.key === current ? "on" : undefined}>{i.label}</a>
      ))}
    </div>
  );
}

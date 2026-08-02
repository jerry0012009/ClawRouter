# Timeline scrolling analysis

## What is proven

The page intentionally suppresses document scrolling at three ancestors: `SidebarInset`, `Main`, and fixed `SectionPageLayout.Content` all use `overflow-hidden`. The intended scroll container is the `ACUWorkTimeline` root (`h-full min-h-0 overflow-y-auto`). The immediate section slot has `min-h-0 flex-1`, so the obvious missing-`min-h-0` defect is not present in current source. The chart is fixed at 34rem/38rem and the Timeline root should overflow vertically when its height is constrained.

ECharts **does intercept wheel input over the chart**. Its inside `dataZoom` explicitly sets `zoomOnMouseWheel: true`; the UI even says “滚轮缩放”. `moveOnMouseWheel` is false, so wheel zooms rather than pans. `preventDefaultMouseMove` applies to pointer drag/move, not wheel, but ECharts' wheel zoom handler consumes the wheel event. Therefore:

- pointer over chart: wheel zooms chart and does not reliably scroll Timeline;
- pointer over title/stats/below chart: no ECharts wheel handler; the Timeline root should scroll;
- drag over chart: `moveOnMouseMove` plus `preventDefaultMouseMove` pans chart and suppresses native pointer movement behavior.

The side Dialog is `modal=false`, has no backdrop, and its own `overflow-y-auto` between `top-4` and `bottom-4`. It should be independently scrollable; it does not itself explain the closed-page initial failure.

## What could not be dynamically proven

No safe Dashboard login state was available. The only apparent test user had no Dashboard access token/session, and its model Tokens were not marked test/audit. Creating login state would change production data. Accordingly the requested three-viewport `clientHeight/scrollHeight`, wheel/PageDown/scrollbar, chart-inside/outside and Dialog runtime matrix was not executed. No Timeline screenshots were captured or committed.

This means the exact runtime node responsible for a report of “cannot scroll anywhere” cannot honestly be named from this audit alone. The strongest source-backed explanation is two-layered:

1. document scrolling is deliberately disabled, making the Timeline root the only valid page scroller;
2. the largest interaction surface is the ECharts canvas, where wheel is deliberately repurposed to zoom.

If scrolling also fails over title/stat areas, runtime computed styles are still required to find which flex ancestor failed to constrain `h-full`; source alone does not show a missing `min-h-0` in the direct chain.

No evidence shows Sidebar JavaScript intercepting wheel. No fixed-height TabsContent is used for Timeline. The fixed viewport height is on `SidebarInset`, and fixed chart height is inside the Timeline.

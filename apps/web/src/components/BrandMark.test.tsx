import { fireEvent, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { BrandMark } from "~/components/BrandMark";

function paths(svg: SVGSVGElement) {
  return Array.from(svg.querySelectorAll("path"));
}

it("server-renders the original mark without starting image loads before hydration", () => {
  const markup = renderToString(<BrandMark />);
  expect(markup).toContain('aria-label="Musubi"');
  expect(markup).not.toContain("<image");
  expect(markup).not.toContain("<mask");
  expect(markup.match(/<path /g)).toHaveLength(2);
});

it("keeps the complete fallback until both arms load and restores it on failure", () => {
  render(<BrandMark />);
  const svg = screen.getByRole("img", { name: "Musubi" }) as unknown as SVGSVGElement;
  const [ink, accent] = Array.from(svg.querySelectorAll("image"));
  const originalPaths = paths(svg).map((path) => path.getAttribute("d"));
  expect(originalPaths.every((path) => path && path.length > 500)).toBe(true);

  fireEvent.load(accent!);
  fireEvent.load(accent!); // Repeated/cached loads of one arm are not a complete pair.
  expect(paths(svg).map((path) => path.getAttribute("d"))).toEqual(originalPaths);
  fireEvent.load(ink!);
  const masks = Array.from(svg.querySelectorAll("mask"));
  expect(paths(svg).map((path) => path.getAttribute("mask"))).toEqual(masks.map((mask) => `url(#${mask.id})`));
  expect(paths(svg).map((path) => path.getAttribute("fill"))).toEqual(["currentColor", "var(--accent-primary)"]);
  expect(ink!.hasAttribute("crossorigin")).toBe(false);

  fireEvent.error(accent!);
  expect(paths(svg).map((path) => path.getAttribute("d"))).toEqual(originalPaths);
  expect(paths(svg).every((path) => !path.hasAttribute("mask"))).toBe(true);
  fireEvent.load(accent!);
  fireEvent.error(ink!);
  expect(paths(svg).map((path) => path.getAttribute("d"))).toEqual(originalPaths);
});

it("isolates multiple marks and preserves decorative callers' SVG props", () => {
  const { container } = render(<><BrandMark aria-hidden="true" focusable="false" className="size-4" width="32" height="32" /><BrandMark /></>);
  const [first, second] = Array.from(container.querySelectorAll("svg"));
  const maskIds = Array.from(container.querySelectorAll("mask")).map((mask) => mask.id);
  expect(new Set(maskIds).size).toBe(4);
  expect(first!.getAttribute("aria-hidden")).toBe("true");
  expect(first!.getAttribute("focusable")).toBe("false");
  expect(first!.getAttribute("class")).toBe("size-4");
  expect(first!.getAttribute("width")).toBe("32");
  expect(first!.getAttribute("height")).toBe("32");
  for (const image of first!.querySelectorAll("image")) fireEvent.load(image);
  expect(paths(first!).every((path) => path.hasAttribute("mask"))).toBe(true);
  expect(paths(second!).every((path) => !path.hasAttribute("mask"))).toBe(true);
});

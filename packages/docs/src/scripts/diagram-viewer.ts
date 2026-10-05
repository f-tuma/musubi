type Diagram = {
  source: HTMLElement;
  button: HTMLButtonElement;
  wrapper: HTMLDivElement;
};

let dispose = () => {};

function initializeDiagramViewer() {
  dispose();
  const dialog = document.querySelector<HTMLDialogElement>("#diagram-viewer");
  const content = document.querySelector<HTMLElement>(".sl-markdown-content");
  if (!dialog || !content) return;

  const viewport = dialog.querySelector<HTMLElement>(".diagram-viewer-viewport")!;
  const canvas = dialog.querySelector<HTMLElement>(".diagram-viewer-canvas")!;
  const title = dialog.querySelector<HTMLElement>("#diagram-viewer-title")!;
  const output = dialog.querySelector<HTMLOutputElement>("output")!;
  const zoomOut = dialog.querySelector<HTMLButtonElement>('[data-diagram-action="out"]')!;
  const zoomIn = dialog.querySelector<HTMLButtonElement>('[data-diagram-action="in"]')!;
  const events = new AbortController();
  const diagrams = new Map<HTMLElement, Diagram>();
  let current: Diagram | undefined;
  let svg: SVGSVGElement | undefined;
  let width = 1;
  let height = 1;
  let scale = 1;
  let fitted = true;
  let previousOverflow = "";
  let frame = 0;
  let backdropPress = false;

  function diagramTitle(source: HTMLElement) {
    const accessibleTitle = source.querySelector("title")?.textContent?.trim();
    if (accessibleTitle) return accessibleTitle;
    const headings = [...content!.querySelectorAll("h1, h2, h3, h4")];
    const heading = headings.filter(element =>
      element.compareDocumentPosition(source) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).at(-1);
    return heading?.textContent?.trim() || "Diagram";
  }

  function fitScale() {
    // The canvas has a one-rem inset on either side at every zoom level.
    const inset = parseFloat(getComputedStyle(viewport).fontSize) * 2;
    return Math.min(1, Math.max(1, viewport.clientWidth - inset) / width,
      Math.max(1, viewport.clientHeight - inset) / height);
  }

  function setScale(next: number, fit = false) {
    const oldScale = scale;
    const centerX = (viewport.scrollLeft + viewport.clientWidth / 2) / oldScale;
    const centerY = (viewport.scrollTop + viewport.clientHeight / 2) / oldScale;
    scale = next;
    fitted = fit;
    canvas.style.width = `${width * scale}px`;
    canvas.style.height = `${height * scale}px`;
    output.value = `${Math.round(scale * 100)}%`;
    zoomOut.disabled = scale <= 0.1;
    zoomIn.disabled = scale >= 4;
    if (fit) viewport.scrollTo(0, 0);
    else viewport.scrollTo(centerX * scale - viewport.clientWidth / 2,
      centerY * scale - viewport.clientHeight / 2);
  }

  function showSvg(rendered: SVGSVGElement) {
    // Move instead of cloning: Mermaid's IDs, CSS, marker references and
    // foreignObject labels remain unique, and restore unchanged on close.
    const bounds = rendered.getBoundingClientRect();
    width = rendered.viewBox.baseVal.width || bounds.width || 1;
    height = rendered.viewBox.baseVal.height || bounds.height || 1;
    svg?.remove();
    svg = rendered;
    canvas.replaceChildren(rendered);
    setScale(fitted ? fitScale() : scale, fitted);
  }

  function restoreDiagram() {
    const target = current;
    if (target && svg) {
      // Prefer a fresh theme render if it completed just before close.
      if (target.source.querySelector("svg")) svg.remove();
      else target.source.append(svg);
    }
    current = undefined;
    svg = undefined;
    canvas.replaceChildren();
    document.documentElement.style.overflow = previousOverflow;
    if (target?.button.isConnected) target.button.focus({ preventScroll: true });
  }

  function open(diagram: Diagram) {
    const rendered = diagram.source.querySelector<SVGSVGElement>("svg");
    if (!rendered || dialog!.open) return;
    current = diagram;
    fitted = matchMedia("(max-width: 40rem)").matches;
    scale = 1;
    viewport.scrollTo(0, 0);
    title.textContent = diagramTitle(diagram.source);
    previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    dialog!.showModal();
    showSvg(rendered);
  }

  function refreshDiagrams() {
    for (const source of content!.querySelectorAll<HTMLElement>("pre.mermaid")) {
      const rendered = source.querySelector<SVGSVGElement>("svg");
      let diagram = diagrams.get(source);
      if (!diagram && rendered && source.hasAttribute("data-processed")) {
        const wrapper = document.createElement("div");
        wrapper.className = "diagram-preview";
        source.before(wrapper);
        wrapper.append(source);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "diagram-open";
        button.textContent = "Open diagram";
        button.setAttribute("aria-haspopup", "dialog");
        button.setAttribute("aria-controls", dialog!.id);
        button.setAttribute("aria-label", `Open diagram: ${diagramTitle(source)}`);
        wrapper.append(button);
        diagram = { source, button, wrapper };
        diagrams.set(source, diagram);
        const entry = diagram;
        button.addEventListener("click", () => open(entry), { signal: events.signal });
        source.addEventListener("click", event => {
          // Keep Mermaid links and selecting/copying labels functional.
          if ((event.target as Element).closest("a") || !getSelection()?.isCollapsed) return;
          open(entry);
        }, { signal: events.signal });
      }
      if (diagram === current && rendered && source.hasAttribute("data-processed")) {
        showSvg(rendered);
      }
    }
  }

  const observer = new MutationObserver(() => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      refreshDiagrams();
    });
  });
  observer.observe(content, { childList: true, subtree: true, attributes: true,
    attributeFilter: ["data-processed"] });

  dialog.addEventListener("click", event => {
    const action = (event.target as Element).closest<HTMLButtonElement>("[data-diagram-action]")?.dataset.diagramAction;
    if (action === "close") dialog.close();
    else if (action === "fit") setScale(fitScale(), true);
    else if (action === "actual") setScale(1);
    else if (action === "in") setScale(Math.min(4, scale * 1.25));
    else if (action === "out") setScale(Math.max(0.1, scale / 1.25));
  }, { signal: events.signal });
  dialog.addEventListener("pointerdown", event => {
    backdropPress = event.target === dialog;
  }, { signal: events.signal });
  dialog.addEventListener("pointerup", event => {
    if (backdropPress && event.target === dialog) dialog.close();
    backdropPress = false;
  }, { signal: events.signal });
  dialog.addEventListener("close", restoreDiagram, { signal: events.signal });
  window.addEventListener("beforeprint", () => {
    if (!dialog.open) return;
    dialog.close();
    // Printing can capture the page before the queued close event restores
    // the SVG. Put it back synchronously so the selected diagram is printed.
    restoreDiagram();
  }, { signal: events.signal });
  const resize = new ResizeObserver(() => {
    if (dialog.open && fitted) setScale(fitScale(), true);
  });
  resize.observe(viewport);

  refreshDiagrams();
  dispose = () => {
    observer.disconnect();
    resize.disconnect();
    cancelAnimationFrame(frame);
    if (dialog.open) {
      dialog.close();
      restoreDiagram();
    }
    events.abort();
    for (const { source, wrapper } of diagrams.values()) {
      wrapper.before(source);
      wrapper.remove();
    }
    dispose = () => {};
  };
}

initializeDiagramViewer();
document.addEventListener("astro:page-load", initializeDiagramViewer);
document.addEventListener("astro:before-swap", () => dispose());

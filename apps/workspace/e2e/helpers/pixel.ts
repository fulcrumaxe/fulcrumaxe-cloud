// apps/workspace/e2e/helpers/pixel.ts
//
// D#6 C42-4: the pixel check shared by the Runs and Pipeline specs. A section is copied (its real DOM, the page's real CSS) onto an empty fixed
// spot at the top left and shot there, so a shot does not depend on where in the window the section sits: a fraction of a pixel, or cut by the
// pane's edge. A runner run has more above its sections than a sandbox run, so that position differs between the two runs being compared.
// The two PNGs are then decoded in a blank page and compared pixel by pixel; the result is numbers, never a file size.

import type { Locator, Page } from "@playwright/test";

/** Copies `section` to the fixed top-left spot and returns the PNG of the copy. Hover, selection and focus marks are not part of the section. */
export async function isolatedShot(page: Page, section: Locator): Promise<Buffer> {
  await section.evaluate((el) => {
    const at = getComputedStyle(el.parentElement!);
    const box = document.createElement("div");
    box.setAttribute("data-testid", "fxc424-iso");
    box.style.cssText = `position:fixed;top:0;left:0;z-index:2147483647;box-sizing:border-box;padding:0;margin:0;pointer-events:none;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;width:${Math.round(el.getBoundingClientRect().width)}px;background:#050805`;
    for (const k of ["fontFamily", "fontSize", "fontWeight", "lineHeight", "color", "letterSpacing", "textTransform", "textShadow"] as const) box.style[k] = at[k];
    box.appendChild(el.cloneNode(true));
    document.body.appendChild(box);
    // A touch leaves a selection or a focus mark behind that fades on its own clock.
    getSelection()?.removeAllRanges();
    (document.activeElement as HTMLElement | null)?.blur();
  });
  return page.locator('[data-testid="fxc424-iso"]').screenshot({ animations: "disabled" });
}

/** Decodes two PNGs in a blank page and counts the pixels whose channels differ by more than `tol` (of 255). */
export async function pixelDiff(page: Page, a: Buffer, b: Buffer, tol = 8) {
  const blank = await page.context().newPage();
  try {
    return await blank.evaluate(
      async ([x, y, t]) => {
        const load = async (s: string) => {
          const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
          const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
          const cv = new OffscreenCanvas(bmp.width, bmp.height);
          const cx = cv.getContext("2d")!;
          cx.drawImage(bmp, 0, 0);
          return { w: bmp.width, h: bmp.height, d: cx.getImageData(0, 0, bmp.width, bmp.height).data };
        };
        const p = await load(x as string);
        const q = await load(y as string);
        if (p.w !== q.w || p.h !== q.h) return { sameSize: false, total: p.w * p.h, differing: Math.abs(p.w * p.h - q.w * q.h) || 1, sizes: [p.w, p.h, q.w, q.h] };
        let differing = 0;
        for (let i = 0; i < p.d.length; i += 4) if (Math.max(Math.abs(p.d[i] - q.d[i]), Math.abs(p.d[i + 1] - q.d[i + 1]), Math.abs(p.d[i + 2] - q.d[i + 2])) > (t as number)) differing++;
        return { sameSize: true, total: p.w * p.h, differing, sizes: [p.w, p.h, q.w, q.h] };
      },
      [a.toString("base64"), b.toString("base64"), tol] as const,
    );
  } finally {
    await blank.close();
  }
}

/** The same size, and no more than 0.05 % of the pixels differing by more than 8 of 255 in any channel. */
export const MAX_DIFF_FRACTION = 0.0005;

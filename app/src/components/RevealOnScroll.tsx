"use client";

import { useEffect } from "react";

// Adds the `.in` class once an element with `.reveal` enters the viewport (or
// after a fallback timeout). Uses a MutationObserver to also catch elements
// added to the DOM AFTER initial mount (e.g. async data renders, tab switches).
// Mounted once at the page level — child elements just need `className="reveal"`.
export function RevealOnScroll() {
  useEffect(() => {
    let observer: IntersectionObserver | undefined;

    const observe = (el: Element) => {
      if (observer) observer.observe(el);
      else el.classList.add("in");
    };

    try {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) e.target.classList.add("in");
          });
        },
        { threshold: 0.05, rootMargin: "0px 0px -40px 0px" },
      );
    } catch {
      // No IntersectionObserver — show everything immediately on the next pass.
    }

    // Initial scan.
    const fallback = setTimeout(() => {
      document.querySelectorAll(".reveal").forEach((el) =>
        el.classList.add("in"),
      );
    }, 1000);
    requestAnimationFrame(() => {
      document.querySelectorAll(".reveal").forEach(observe);
    });

    // Watch for `.reveal` elements added later (tab switches, async data).
    const mutationObserver = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((n) => {
          if (!(n instanceof Element)) return;
          if (n.classList?.contains("reveal")) observe(n);
          n.querySelectorAll?.(".reveal").forEach(observe);
        });
      }
    });
    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      clearTimeout(fallback);
      observer?.disconnect();
      mutationObserver.disconnect();
    };
  }, []);

  return null;
}

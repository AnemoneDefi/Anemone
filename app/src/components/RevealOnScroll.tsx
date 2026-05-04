"use client";

import { useEffect } from "react";

// Replaces the prototype's `useReveal` hook. Adds the `.in` class once an
// element with `.reveal` enters the viewport (or after a fallback timeout).
// Mounted once at the page level — child elements just need `className="reveal"`.
export function RevealOnScroll() {
  useEffect(() => {
    const els = document.querySelectorAll(".reveal");
    const fallback = setTimeout(() => {
      els.forEach((el) => el.classList.add("in"));
    }, 1000);

    let observer: IntersectionObserver | undefined;
    try {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((e) => {
            if (e.isIntersecting) e.target.classList.add("in");
          });
        },
        { threshold: 0.05, rootMargin: "0px 0px -40px 0px" },
      );
      requestAnimationFrame(() => els.forEach((el) => observer!.observe(el)));
    } catch {
      els.forEach((el) => el.classList.add("in"));
    }

    return () => {
      clearTimeout(fallback);
      if (observer) observer.disconnect();
    };
  }, []);

  return null;
}

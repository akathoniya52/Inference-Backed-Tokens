import { useEffect, useState } from 'react';
import { useLocation } from 'react-router-dom';

// The reading line sits 20% down the viewport but never above 100 px: just below
// the sections' 96 px scroll margin (`scroll-mt-24`), so a section the browser has
// scrolled to always counts as under the line.
const LINE_TOP_FRACTION = 0.2;
const LINE_MIN_PX = 100;

function readingLineY(): number {
  return Math.max(window.innerHeight * LINE_TOP_FRACTION, LINE_MIN_PX);
}

function atPageBottom(): boolean {
  return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 1;
}

function sectionUnderReadingLine(sections: readonly HTMLElement[]): HTMLElement | null {
  const [first] = sections;
  if (first === undefined) return null;
  if (atPageBottom()) return sections[sections.length - 1] ?? first;
  const lineY = readingLineY();
  let current = first;
  for (const section of sections) {
    if (section.getBoundingClientRect().top <= lineY) current = section;
  }
  return current;
}

/**
 * Which of `ids` (section element ids, in page order) the reader is on. The URL
 * hash wins whenever it names a section; otherwise the scroll position decides:
 * the last section whose top has passed the reading line, the first section
 * while the page is scrolled above it, and the last section at the bottom of
 * the page. Starts on the hash or the first id, and re-reads the scroll
 * position on mount only when the page is already scrolled. `ids` must be a
 * stable reference.
 */
export function useActiveSection(ids: readonly string[]): string | null {
  const { hash } = useLocation();
  const hashId = hash.startsWith('#') ? hash.slice(1) : hash;
  const [active, setActive] = useState<string | null>(() =>
    ids.includes(hashId) ? hashId : (ids[0] ?? null),
  );

  useEffect(() => {
    if (ids.includes(hashId)) setActive(hashId);
  }, [hashId, ids]);

  useEffect(() => {
    const sections = ids
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (sections.length === 0) return;

    const update = () => {
      const section = sectionUnderReadingLine(sections);
      if (section !== null) setActive(section.id);
    };
    if (window.scrollY > 0) update();
    window.addEventListener('scroll', update, { passive: true });
    return () => window.removeEventListener('scroll', update);
  }, [ids]);

  return active;
}

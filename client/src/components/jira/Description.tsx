import { useLayoutEffect, useRef, useState } from 'react';

import { renderMarkdown } from '../../lib/markdown';

/* The ticket's description with its clamp and `Show more`. Moved out of `JiraDetail.tsx` unchanged (Jira detail tabs plan, Task 4) so the Detail body and
   its tabs can draw it; DESIGN.md §8.9.2. */

/**
 * The description, collapsed to its first few lines (`.jira-desc`'s max-height) with a `Show more` under it — a long ticket otherwise pushes the Children
 * and everything after them a screen down, which is the very thing that makes Jira's own issue view hard to scan. The toggle is drawn only when the text
 * actually overflows the clamp, measured rather than guessed from a character count, because a short line of Markdown can render as a tall table and a
 * long one as a single paragraph. The measure re-runs when the content's own box changes (an image arriving, the modal folding under 700 px) where the
 * browser has a `ResizeObserver`; where it has none, the one measure after the HTML lands is what it gets.
 */
export function Description({ markdown }: { markdown: string }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const html = renderMarkdown(markdown);

  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (box === null || content === null) return;
    // Measured against the clamp only while collapsed: expanded, the box is as tall as its content and would always read as fitting.
    const measure = (): void => {
      if (!box.classList.contains('open')) setOverflows(box.scrollHeight > box.clientHeight + 1);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [html]);

  return (
    <>
      <div ref={outer} className={expanded ? 'jira-desc open' : overflows ? 'jira-desc clamped' : 'jira-desc'}>
        <div ref={inner} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      {(overflows || expanded) && (
        <button type="button" className="jira-desc-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}

import { Card, CardContent } from "@/components/ui/card";
import { PAGE_GUIDES, type GuideKey } from "@/lib/page-guides";
import { Lightbulb, ArrowRight } from "lucide-react";

/**
 * PageGuide — the always-visible plain-language guidance strip at the top of
 * each user-facing page. See `page-guides.ts` for copy.
 *
 * v8.2i (instructions): every heir-facing page mounts one of these. The card
 * is intentionally prominent — new users need to read it, even on the
 * fifteenth visit. Copy stays short so the visual weight comes from placement,
 * not from length.
 */
export function PageGuide({ guideKey }: { guideKey: GuideKey }) {
  const guide = PAGE_GUIDES[guideKey];
  if (!guide) return null;
  return (
    <Card
      className="mb-6 border-primary/30 bg-primary/[0.04]"
      data-testid={`card-guide-${guideKey}`}
    >
      <CardContent className="p-5 md:p-6">
        <div className="flex items-start gap-3">
          <div
            className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
            aria-hidden="true"
          >
            <Lightbulb className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-lg font-semibold md:text-xl">
              {guide.title}
            </h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground md:text-base">
              {guide.body}
            </p>
            <div className="mt-3 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-primary md:text-sm">
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{guide.next}</span>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

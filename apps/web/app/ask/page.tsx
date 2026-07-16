import { Suspense } from "react";
import { AskScreen } from "../../components/ask/AskScreen";

export const metadata = {
  title: "Ask · Azen OS",
};

export const dynamic = "force-dynamic";

/**
 * Ask Azen — interactive, data-grounded business Q&A. The screen is fully
 * client-driven (streaming + history); `useSearchParams` (for the `?session=`
 * deep link from the palette's Expand) requires a Suspense boundary.
 */
export default function AskPage() {
  const hasAnthropicKey = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return (
    <Suspense fallback={null}>
      <AskScreen hasAnthropicKey={hasAnthropicKey} />
    </Suspense>
  );
}

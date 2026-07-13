import { Suspense } from "react";
import { AskScreen } from "../../components/ask/AskScreen";

export const metadata = {
  title: "Ask · Azen OS",
};

/**
 * Ask Azen — interactive, data-grounded business Q&A. The screen is fully
 * client-driven (streaming + history); `useSearchParams` (for the `?session=`
 * deep link from the palette's Expand) requires a Suspense boundary.
 */
export default function AskPage() {
  return (
    <Suspense fallback={null}>
      <AskScreen />
    </Suspense>
  );
}

import { useSearchParams } from "react-router-dom";

/** `?lot=<site id>` on the page URL: the lot a dashboard or leaderboard is showing ("" = whole yard). */
export function useLotParam(): [string, (lot: string) => void] {
  const [params, setParams] = useSearchParams();
  const set = (lot: string) =>
    setParams((p) => {
      const n = new URLSearchParams(p);
      if (lot) n.set("lot", lot);
      else n.delete("lot");
      return n;
    }, { replace: true });
  return [params.get("lot") ?? "", set];
}

/** Query-string piece for a lot: lotQS("abc") → "?site_id=abc", lotQS("abc", "&") → "&site_id=abc", lotQS("") → "". */
export const lotQS = (lot: string, sep: "?" | "&" = "?") => (lot ? `${sep}site_id=${encodeURIComponent(lot)}` : "");

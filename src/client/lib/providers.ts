import { useEffect, useState } from "react";
import { api } from "./api";

/** What this particular deploy is configured to do — a deploy with no OAuth client or no
 * email provider should not offer the user either. */
export interface Providers {
  google: boolean;
  passwordReset: boolean;
}

const FALLBACK: Providers = { google: false, passwordReset: false };

/** Assumes neither is available until told otherwise, so a slow or failed call hides the
 * options rather than offering ones that would then fail. */
export function useProviders(): Providers {
  const [providers, setProviders] = useState<Providers>(FALLBACK);

  useEffect(() => {
    api
      .get<Providers>("/auth/providers")
      .then(setProviders)
      .catch(() => setProviders(FALLBACK));
  }, []);

  return providers;
}

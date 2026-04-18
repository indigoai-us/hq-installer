/** Result of resolving a user's company from vault-service. */
export type HandoffResult =
  | {
      found: true;
      companyUid: string;
      companySlug: string;
      companyName: string;
      bucketName: string;
      personUid: string;
      role: string;
    }
  | { found: false };

export interface SynonymItem {
  id: string;
  /** Short/abbreviated form; always lower-case. */
  from: string;
  /** Comma-separated full expansions. */
  to: string;
}

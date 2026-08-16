/**
 * Plain-language guidance shown at the top of each user-facing page.
 *
 * Keep sentences short. Second-person voice. Say what to do, why it matters,
 * and what happens next. No jargon. No exclamation points.
 */

export type GuideKey =
  | "welcome-heir"
  | "welcome-captain"
  | "profile"
  | "inventory-heir"
  | "inventory-captain"
  | "review-categories"
  | "rank"
  | "draft"
  | "results"
  | "admin"
  | "setup";

export type PageGuide = {
  /** Short heading. Answers "what page am I on?" */
  title: string;
  /** 2-4 short sentences. Answers "what do I do here and why?" */
  body: string;
  /** One-liner. Answers "what happens after this?" */
  next: string;
};

export const PAGE_GUIDES: Record<GuideKey, PageGuide> = {
  "welcome-heir": {
    title: "Welcome",
    body:
      "This is where you sign in as yourself. Tap your name to open your private space. Nothing you do here is visible to anyone else until you submit each step.",
    next: "Next: confirm your contact information on your profile.",
  },
  "welcome-captain": {
    title: "Welcome",
    body:
      "This is your control room. From here you register the heirs, add items, and move the estate through each phase. Practice with the sample walkthrough before inviting the real family.",
    next: "Next: run the solo sample walkthrough to learn the flow.",
  },
  profile: {
    title: "Confirm your contact information",
    body:
      "Add your name, email, and phone number so the family can reach you and so notifications go to the right place. You can update these later from this same screen.",
    next: "Next: review the inventory of items to be distributed.",
  },
  "inventory-heir": {
    title: "Review the inventory",
    body:
      "Take a slow look at every item in the estate. As you review, flag anything special to you as High value or Heirloom. Items you leave unflagged stay in the main round with everyday belongings.",
    next: "Next: rank the items you want, in order of what matters most.",
  },
  "inventory-captain": {
    title: "The estate inventory",
    body:
      "Add every item you want included in the distribution. Photos, room, and a short name are enough to start. You can edit categories and refine details later.",
    next: "Next: confirm the categories, then invite the heirs to rank.",
  },
  "review-categories": {
    title: "Review categories",
    body:
      "Categories keep the inventory organized and help the app suggest fair matches. Add, rename, or remove categories so they fit this estate. Only the captain sees this screen. (The captain is the heir running the session, or a trustee who has stepped in.)",
    next: "Next: heirs review the inventory and start ranking.",
  },
  rank: {
    title: "Rank your items",
    body:
      "Drag the items you want to the top. Highest priority first. If something is a family heirloom or has unusual value, use the badge menu on the item to escalate it — those get their own draft rounds after the main one.",
    next: "Next: submit your list. When everyone has submitted, the draft begins.",
  },
  draft: {
    title: "The draft",
    body:
      "The draft picks items round by round using everyone's ranked lists. When it is your turn, the app suggests your next-highest item. Confirm the suggestion or pick something else from the pool.",
    next: "Next: after the last round, the final results are shown.",
  },
  results: {
    title: "Final results",
    body:
      "This is the record of who received what. Save or print a copy for your files. Anything left unawarded is listed at the bottom so the captain can decide what to do next.",
    next: "Next: the captain closes it out or handles leftovers.",
  },
  admin: {
    title: "Administration",
    body:
      "Manage the session from here: pause and resume, register heirs, toggle auto-submit, and advance phases. Changes here affect what every user sees.",
    next: "Next: launch the next phase when everyone is ready.",
  },
  setup: {
    title: "Set up the estate",
    body:
      "Start by naming the estate and adding yourself as the captain — the heir who will run this session for the family. (If a trustee will run the session instead, you can invite them from Administration once you are inside.) Once you are in, the recommended path is: run the solo sample walkthrough, then a family rehearsal, then start the real distribution.",
    next: "Next: complete the three-step training arc, then begin the real estate.",
  },
};

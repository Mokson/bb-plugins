// A provider `user_question` carries its words in `questions[].prompt` and
// leaves the title generic. `text_regex` only saw the title and the data blob,
// so a rule written against the question a case expects never fired and the
// run stalled on an unanswered interaction.
import { expect, test } from "vitest";
import { interactionText, matchAnswer } from "../src/eval/runner.js";

const QUESTION = {
  id: "int-1",
  status: "pending",
  payload: {
    kind: "user_question",
    title: "Question",
    questions: [
      {
        id: "q1",
        prompt: "Which tracker should this bug fix land against?",
        allowFreeText: true,
      },
    ],
  },
};

test("text_regex is tested against the question prompt", () => {
  expect(interactionText(QUESTION)).toContain("Which tracker");
});

test("a rule matching the prompt answers the interaction", () => {
  const rules = [
    { respond: "none", textRegex: "tracker", remaining: null },
  ];

  expect(matchAnswer(rules, QUESTION)?.respond).toBe("none");
});

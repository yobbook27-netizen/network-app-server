import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { buildResumeText } from "./lib/resumeText.js";
import { SHARED_STANDARD_SYSTEM, CRITIC_TASK, TAILORING_TASK } from "./lib/resumePrompt.js";

const PORT = process.env.PORT || 4001;
const MODEL = "claude-opus-5";

if (!process.env.ANTHROPIC_API_KEY) {
  console.error(
    "Missing ANTHROPIC_API_KEY. Copy .env.example to .env in this directory and set your key, then restart."
  );
  process.exit(1);
}

const anthropic = new Anthropic();

// ── WHAT EACH CALL COST, WRITTEN DOWN WHERE IT CAN BE READ ───────────────────
// Session 60. The handlers below already log their failures; nothing logged what a SUCCESS
// spent, so the only record of the account draining was the invoice. `output_tokens` includes
// adaptive thinking, which is where the money on this model actually goes.
const PRICE_PER_MTOK = { input: 5.0, output: 25.0 }; // claude-opus-5, USD per 1M tokens
function logUsage(path, response, startedAt) {
  const u = response?.usage || {};
  const inTok = u.input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  const cached = u.cache_read_input_tokens ?? 0;
  // Session 61. A cache WRITE bills at 1.25x input and a READ at 0.1x, so a log that shows only
  // `in` cannot tell a cheap call from an expensive one once caching is on.
  const written = u.cache_creation_input_tokens ?? 0;
  const cost =
    (inTok / 1e6) * PRICE_PER_MTOK.input +
    (written / 1e6) * PRICE_PER_MTOK.input * 1.25 +
    (cached / 1e6) * PRICE_PER_MTOK.input * 0.1 +
    (outTok / 1e6) * PRICE_PER_MTOK.output;
  console.log(
    `[usage] ${path} model=${MODEL} in=${inTok} out=${outTok} cache_write=${written} cache_read=${cached} ` +
      `stop=${response?.stop_reason} ms=${Date.now() - startedAt} cost=$${cost.toFixed(4)}`
  );
}
/*
  ── A FAILURE THE USER CAN SEE MUST HAVE A CAUSE SOMEBODY CAN READ — SESSION 60 ──────────────

  OBSERVED, session 59: every handler below ended `res.status(500).json({ error: "Failed to …" })`
  and threw the real reason away. An expired key, an exhausted balance and a bug in this file all
  produced the same 500 and the same sentence, and the actual cause existed only in this process's
  stderr — which no user reads, and no future session reads either.

  So the cause is CLASSIFIED here and travels as a slug. Three things this deliberately does not
  do:

    • It does not put the upstream message in the response. Session 58's rule is that no raw
      upstream string reaches a screen, and the safest way to keep that true is for the string
      never to leave this process. The slug is a closed set written by us.

    • It does not tell the user which. `reason` is for the APP to choose a sentence with, and the
      app's sentences are in src/api/client.ts. The `error` field stays the plain one.

    • It does not distinguish anything the model told us in prose. Only the HTTP status and the
      SDK's own error type decide the slug.

  THE SPLIT THAT MATTERS is between what the person holding the phone can do something about and
  what only Joe can. `paused` and `busy` are Joe's; nothing on the device is wrong.
*/
function classifyUpstream(err) {
  const status = err?.status ?? err?.statusCode;
  const type = err?.error?.error?.type ?? err?.error?.type;

  // An exhausted balance arrives as a 400 with its own type, NOT as a payment-specific status.
  // It must not read as a broken feature, so it is grouped with the key rather than with a bug.
  if (type === "invalid_request_error" && /credit balance|too low|billing/i.test(err?.message ?? "")) {
    return { reason: "paused", status: 503 };
  }
  if (status === 401 || status === 403 || type === "authentication_error" || type === "permission_error") {
    return { reason: "paused", status: 503 };
  }
  if (status === 402) return { reason: "paused", status: 503 };
  if (status === 429 || type === "rate_limit_error") return { reason: "busy", status: 503 };
  if (typeof status === "number" && status >= 500) return { reason: "upstream", status: 502 };
  if (err?.name === "APIConnectionError" || err?.name === "APIConnectionTimeoutError") {
    return { reason: "upstream", status: 502 };
  }
  return { reason: "unknown", status: 500 };
}

/**
 * One place every handler's catch block goes through, so a new endpoint cannot forget to
 * classify. `sentence` is the endpoint's own plain wording, unchanged from before.
 */
function failed(res, path, err, sentence) {
  const { reason, status } = classifyUpstream(err);
  console.error(`[fail] ${path} reason=${reason} status=${status}:`, err);
  res.status(status).json({ error: sentence, reason });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// POST /api/roadmap
// body: { survey: {...survey fields...}, userContext: string }
//
// ORPHAN. No caller since session 37, when the Roadmap screen's AI block was deleted; the two
// client functions and the three result types went with it, so nothing in the app can reach here
// without new code. Session 62 called it directly to find out whether it still works.
//
// IT DOES. HTTP 200, a well-formed { milestones, nextStepTitle, nextStepDesc, modules }, on a
// survey of seven fields. It is NOT retired because it broke.
//
// BUT IT TOOK 68.9 SECONDS, and the app's own deadline is AI_TIMEOUT_MS = 30,000
// (src/utils/fetchWithTimeout.ts, session 58). Reconnecting this endpoint as it stands produces a
// call the app aborts every single time. That is the first thing to fix, before the question of
// whether the screen wants the feature back.
//
// NOT REMOVED, on purpose. See src/store/roadmapAi.ts for why the control exists with nothing
// behind it, and the standing decision that the endpoint stays until the screen's question is
// settled. Deleting a working endpoint to tidy up is how the roadmap feature got two false
// blockers written about it in the first place.
// ---------------------------------------------------------------------------
app.post("/api/roadmap", async (req, res) => {
  try {
    const { survey = {}, userContext = "" } = req.body || {};

    const goalLabel = survey.goal === "Other" ? survey.otherGoal || "your goal" : survey.goal;
    const majorLine = [
      survey.major,
      survey.isDoubleMajor && survey.major2 ? `& ${survey.major2}` : null,
      survey.minor ? `(minor: ${survey.minor})` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const yearLabel = survey.year === "Other" ? survey.yearOther || "Student" : survey.year || "Student";

    const prompt = `You are a career roadmap assistant helping a student build a specific, realistic long-term plan — not generic advice.

Student info:
- School: ${survey.school || "not specified"}
- Year: ${yearLabel}
- Location: ${survey.location || "not specified"}
- Major: ${majorLine || "not specified"}
- GPA: ${survey.gpa || "not specified"}
- Current status: ${survey.status || "not specified"}${survey.currentRole ? ` (${survey.currentRole}${survey.currentCompany ? " at " + survey.currentCompany : ""})` : ""}
- Skills: ${survey.skillsInput || "not specified"}
- Certifications: ${survey.certInput || "none yet"}
- Career goal: ${goalLabel || "not specified"}
- Additional context from the student: "${userContext || "none provided"}"

Using all of this, write a specific 5-point roadmap, one suggested next step, and a self-study learning path of 6-8 modules that teaches this student what they'd need to know to break into this specific field — similar to a structured curriculum a self-directed learner would follow (concepts, key terminology, how the industry works, skills, certifications, common mistakes). The next step should assume basics like a LinkedIn profile and resume are already in place (those are handled separately) — focus it on the next concrete, field-specific action instead. Be concrete and specific to their actual goal and major, not generic career advice.

Respond with ONLY valid JSON, no markdown formatting, no code fences, no preamble, matching exactly this shape:
{
  "milestones": [
    {"year": "Now", "label": "..."},
    {"year": "Year 2", "label": "..."},
    {"year": "Year 5", "label": "..."},
    {"year": "Year 10", "label": "..."},
    {"year": "Year 15", "label": "..."}
  ],
  "nextStepTitle": "...",
  "nextStepDesc": "...",
  "modules": [
    {"title": "...", "desc": "..."}
  ]
}
Include 6-8 items in "modules", ordered from foundational to more advanced.`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              milestones: {
                type: "array",
                items: {
                  type: "object",
                  properties: { year: { type: "string" }, label: { type: "string" } },
                  required: ["year", "label"],
                  additionalProperties: false,
                },
              },
              nextStepTitle: { type: "string" },
              nextStepDesc: { type: "string" },
              modules: {
                type: "array",
                items: {
                  type: "object",
                  properties: { title: { type: "string" }, desc: { type: "string" } },
                  required: ["title", "desc"],
                  additionalProperties: false,
                },
              },
            },
            required: ["milestones", "nextStepTitle", "nextStepDesc", "modules"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to generate a roadmap for this input." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to generate roadmap.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/roadmap/module-content
// body: { survey: {...survey fields...}, moduleTitle: string, moduleDesc: string }
//
// ORPHAN, the same one, and it fed the six-module "Learning path" that went with the block.
//
// Session 62 called it: HTTP 200, { overview, keyConcepts, actionSteps }, in 25.8 SECONDS. That
// clears the 30-second deadline by four seconds, which is not margin — a slower day fails. Of the
// two orphans this is the one that could be reconnected first, and it is also the one with less
// to reconnect to, because the module list it writes content FOR came from /api/roadmap above.
//
// NOT REMOVED. Same reasoning as above.
// ---------------------------------------------------------------------------
app.post("/api/roadmap/module-content", async (req, res) => {
  try {
    const { survey = {}, moduleTitle = "", moduleDesc = "" } = req.body || {};
    if (!moduleTitle.trim()) {
      return res.status(400).json({ error: "moduleTitle is required." });
    }

    const goalLabel = survey.goal === "Other" ? survey.otherGoal || "their goal" : survey.goal;

    const prompt = `You are writing one module of a self-study learning path for a student working toward: ${goalLabel || "their career goal"}${survey.major ? `, studying ${survey.major}` : ""}.

This specific module is titled "${moduleTitle}" — ${moduleDesc || "no further description given"}.

Write the actual lesson content for this module: a short overview paragraph (2-4 sentences), a list of 3-5 key concepts a self-directed learner should understand, and a list of 3-5 concrete action steps they could take right now to start learning this (specific resources, search terms, or exercises — not vague advice). Be specific and field-appropriate, not generic.

Respond with ONLY valid JSON, no markdown formatting, no code fences, no preamble, matching exactly this shape:
{
  "overview": "...",
  "keyConcepts": ["...", "..."],
  "actionSteps": ["...", "..."]
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              overview: { type: "string" },
              keyConcepts: { type: "array", items: { type: "string" } },
              actionSteps: { type: "array", items: { type: "string" } },
            },
            required: ["overview", "keyConcepts", "actionSteps"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to generate content for this module." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to generate module content.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/resume/critique
// body: { resume: {...resumeFields shape, see buildResumeText...} }
// ---------------------------------------------------------------------------
app.post("/api/resume/critique", async (req, res) => {
  try {
    const { resume = {} } = req.body || {};
    const resumeText = buildResumeText(resume);

    const prompt = `${CRITIC_TASK}

THE RESUME TO REVIEW
${resumeText}

Respond with ONLY valid JSON, no markdown, no preamble, matching exactly:
{
  "score": 1-10,
  "strengths": ["...", "..."],
  "improvements": ["...", "..."],
  "questions": ["...", "..."]
}
Reference specific bullets or sections from the resume above. Plain text throughout, no markdown.`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      // The standard is identical on every call to either resume endpoint, so it is cached and
      // the two endpoints share one entry. See lib/resumePrompt.js for why that became possible.
      system: SHARED_STANDARD_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              score: { type: "integer" },
              strengths: { type: "array", items: { type: "string" } },
              improvements: { type: "array", items: { type: "string" } },
              // The mechanism the whole standard turns on. Without somewhere to put a question,
              // a model that needs a number has two options left — omit the bullet, or invent
              // the number — and session 60 and 61 both measured which one it picks.
              questions: { type: "array", items: { type: "string" } },
            },
            required: ["score", "strengths", "improvements", "questions"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to critique this resume." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to critique resume.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/resume/jd-compare
// body: { resume: {...}, jobDescription: string }
// ---------------------------------------------------------------------------
app.post("/api/resume/jd-compare", async (req, res) => {
  try {
    const { resume = {}, jobDescription = "" } = req.body || {};
    if (!jobDescription.trim()) {
      return res.status(400).json({ error: "jobDescription is required." });
    }
    const resumeText = buildResumeText(resume);

    const prompt = `THE RESUME
${resumeText}

THE JOB DESCRIPTION
${jobDescription}

${TAILORING_TASK}

Respond with ONLY valid JSON, no markdown, no preamble, matching exactly:
{
  "matched": ["...", "..."],
  "missing": ["...", "..."],
  "suggestions": ["...", "..."],
  "questions": ["...", "..."]
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      // Same cached block as /api/resume/critique, and deliberately byte-identical to it.
      system: SHARED_STANDARD_SYSTEM,
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              matched: { type: "array", items: { type: "string" } },
              missing: { type: "array", items: { type: "string" } },
              suggestions: { type: "array", items: { type: "string" } },
              // Same reason as /api/resume/critique: a suggestion is prose the user pastes onto
              // a document going to an employer, so the figure it wants has to have somewhere
              // to go that is not the middle of the sentence.
              questions: { type: "array", items: { type: "string" } },
            },
            required: ["matched", "missing", "suggestions", "questions"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to compare this resume to the job description." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to compare resume to job description.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/templates/generate
// body: { description: string, survey: {...}, contact: { name, role, company, categories } | null }
// ---------------------------------------------------------------------------
app.post("/api/templates/generate", async (req, res) => {
  try {
    const { description = "", survey = {}, contact = null } = req.body || {};
    if (!description.trim()) {
      return res.status(400).json({ error: "description is required." });
    }

    const yearLabel = survey.year === "Other" ? survey.yearOther || "" : survey.year || "";
    const goalLabel = survey.goal === "Other" ? survey.otherGoal || "" : survey.goal || "";
    const contactLine = contact
      ? `The message is for ${contact.name}${contact.role ? `, ${contact.role}` : ""}${
          contact.company ? ` at ${contact.company}` : ""
        }.`
      : "No specific recipient was chosen — keep it general.";

    const prompt = `You are helping a student write a networking outreach message template.

What the student asked for: "${description}"

About the student:
- Name: ${survey.fullName || "not specified"}
- School: ${survey.school || "not specified"}
- Year: ${yearLabel || "not specified"}
- Major: ${survey.major || "not specified"}
- Career goal: ${goalLabel || "not specified"}

${contactLine}

Write ONE short outreach template (roughly 40-90 words) that matches what they asked for. Rules:
- Use the placeholder tokens [Name], [Your name], [Year], [School], [Major], [Company], [Field] wherever that detail belongs, exactly in that bracketed form. The app substitutes real values into these tokens, so never write the student's actual name or school into the message body.
- Sound like a real person, not a form letter. No corporate filler, no "I hope this email finds you well".
- Be specific to the request. Do not hedge or offer alternatives.
- Plain text only: no markdown, no subject line, no signature block.

Also give it a short title (3-6 words) and a category label (2-3 words, e.g. "Cold outreach", "Follow-up", "Thank you").

Respond with ONLY valid JSON, no markdown, no preamble, matching exactly:
{
  "title": "...",
  "category": "...",
  "text": "..."
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              title: { type: "string" },
              category: { type: "string" },
              text: { type: "string" },
            },
            required: ["title", "category", "text"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write this template." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to generate a template.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/meeting/brief
// body: { contact: {...}, survey: {...}, interactions: [...], notes: string, occasion: string }
//
// ORPHAN as of session 125b, Part 0. Pre-meeting prep: what the user already knows about this
// person, plus a few openers. The contact's private fields (notes, ratings, logged interactions)
// ARE sent here, unlike /api/templates/generate — the whole point of a brief is to summarize
// what's on file, and the user is asking about their own record of their own contact.
//
// MeetingBriefScreen.tsx's "Before" mode was its only caller and now calls /api/brief below
// instead, with the same narrower payload the row-level brief uses — see generateRowBrief in
// api/client.ts and Part 0 of SESSION_125B_FINDINGS.md. NOT REMOVED, same reasoning session 37
// left /api/roadmap standing: the route is not what's wrong, the caller was.
// ---------------------------------------------------------------------------
app.post("/api/meeting/brief", async (req, res) => {
  try {
    const { contact = null, survey = {}, interactions = [], notes = "", occasion = "" } = req.body || {};
    if (!contact || !contact.name) {
      return res.status(400).json({ error: "contact is required." });
    }

    const goalLabel = survey.goal === "Other" ? survey.otherGoal || "" : survey.goal || "";
    /*
      ── A ROW SAYS WHERE IT CAME FROM NOW — SESSION 61 ────────────────────────────────────────

      This used to render `- {date}: {type}` and nothing else, which presented three different
      kinds of evidence as one kind. A row the user typed after a coffee certifies they were
      there. A row the calendar backfill wrote certifies a meeting was SCHEDULED. A row the Gmail
      importer wrote certifies a message left the account. The brief was reading all three as
      "a conversation you had", and then writing the user a sentence to say out loud about it.

      `source` is undefined on every entry logged before that field existed, and the app's own
      type says undefined means manual (src/types/index.ts, ActivityLogEntry).
    */
    const PROVENANCE = {
      manual: "logged by hand",
      calendar: "from their calendar — scheduled, not confirmed",
      gmail: "from their sent mail — sent, not necessarily answered",
    };
    const historyLines = Array.isArray(interactions) && interactions.length > 0
      ? interactions
          .slice(0, 20)
          .map((i) => {
            const from = PROVENANCE[i.source] || PROVENANCE.manual;
            return `- ${i.date || "date unknown"}: ${i.type || "Contact"} (${from})${
              i.note ? ` — ${i.note}` : " — no note written"
            }`;
          })
          .join("\n")
      : "- NOTHING LOGGED. There is no record of these two ever having been in contact.";

    const prompt = `You are helping someone prepare for a conversation with a person in their professional network.

ABOUT THE PERSON THEY'RE MEETING
- Name: ${contact.name}
- Role: ${contact.role || "not on file"}
- Company: ${contact.company || "not on file"}
- Industry: ${contact.industry || "not on file"}
- School: ${contact.school || "not on file"}
- Location: ${contact.location || "not on file"}
- How they know each other: ${(contact.categories || []).join(", ") || "not categorized"}
- Relationship warmth: ${contact.warmthLabel || "unknown"}${contact.daysSinceContact != null ? ` (last logged contact ${contact.daysSinceContact} days ago)` : ""}

THEIR OWN SAVED NOTES ON THIS PERSON
${notes.trim() || "(none)"}

LOGGED INTERACTION HISTORY (most recent first)
${historyLines}

ABOUT THE USER
- Name: ${survey.fullName || "not specified"}
- School: ${survey.school || "not specified"}
- Year: ${survey.year === "Other" ? survey.yearOther || "" : survey.year || "not specified"}
- Major: ${survey.major || "not specified"}
- Career goal: ${goalLabel || "not specified"}

OCCASION FOR THIS CONVERSATION
${occasion.trim() || "No specific occasion given — general catch-up."}

WHAT YOU ARE SEEING, AND WHAT YOU ARE NOT

You are seeing ONE contact record. You have been given no information at all about the rest of
this user's network — not its size, not who else is in it, not which industries, companies,
cities or seniorities it covers, not how many people they know.

So you may not characterise it. Every one of these is a claim you cannot make:

  "one of the few finance contacts in your network"
  "one of the few people you know in Boston"
  "one of your most senior connections"
  "a rare contact at a firm like this"

They are forbidden in the summary, in the context bullets, and above all in a starter, which is
a sentence the user will say out loud to a real person who may know it is untrue. If this person
is worth the user's time, say why from THEIR OWN RECORD — their role, their firm, their city,
what the user wrote about them — never by comparing them to people you have not been shown.

The same rule holds for the person themselves. A field that says "not on file" is a fact about
the record and not an invitation to work the answer out. Do not infer what a company does from
its name, what a role involves from its title, or what someone studied from where they work. If
the industry line is blank you do not know whether this firm is buy-side, sell-side, a lender or
a family office, and calling it one is the same defect in a smaller space.

HOW TO READ THE INTERACTION HISTORY

Every row is one logged contact between the user and this person, and its type is one of: Call,
Text, Email, Meeting, WhatsApp, In Person, Coffee/Meal, Video Call, Other. Nothing else is a row
type. In particular, no row means "this record was created" — the app never logs that as an
interaction, so a date on this list is a date they were in contact and not a date the contact
was filed.

Each row says where it came from, and the three are not interchangeable:

  logged by hand   the user typed this after it happened. Only this kind certifies that they
                   were there and remember it.
  from a calendar  an event on the user's device calendar that named this person. Evidence the
                   meeting was SCHEDULED. Not that it happened, not that they spoke.
  from sent mail   a message the user's account sent to this person. Evidence something went
                   out. Not that it was read, not that it was answered.

Never upgrade one into another. A calendar row is not "the coffee you two had". A sent-mail row
is not "your last conversation".

A row with no note tells you a contact of that type happened on that date and NOTHING about what
was said. That is the normal case, not an unlucky one: on a real device, none of 276 logged
interactions carried a note. Do not guess at the content of an interaction you were given only
the date and type of.

"NOTHING LOGGED" means the app has no record of these two ever being in contact. It does not
mean the relationship is new, and it does not mean it has gone quiet. It means unknown.

DO NOT INVENT A SHARED PAST

Unless a row above says they were in contact, or the user's own notes say so, nothing you write
may presume the two of them have ever spoken. "Reconnect", "since we last spoke", "it's been a
while", "catch up", "again", "as I mentioned" — each of those asserts a history that may not
exist, and a starter is the worst place to put one, because the user says it to their face.

The warmth line is also not a history. "Not yet rated" means the user has never rated this
relationship and has never logged a contact: it means unknown, not distant and not new. A warmth
of Warm, Cooling or Cold with no day count is the user's own rough answer to "when did you last
speak", not a record of anything.

A THIN RECORD MUST PRODUCE A THIN BRIEF

Most records are thin. If all you have is a name, a role, a company and a city, then the honest
brief is short, says plainly that there is almost nothing on file, and helps the user open a
first real conversation with someone they know little about. That is genuinely useful.

A brief that reads richly off four fields is worse than one that admits the file is empty,
because the user believes it and walks in prepared for a relationship they do not have. Do not
pad. Fewer, truer bullets beat the maximum count every time.

WRITE THE BRIEF

- Ground everything in the facts above. If something isn't on file, do not invent it — say what's
  missing instead when it matters.
- "summary" is up to 4 sentences on who this person is to the user and what the record actually
  supports about where things stand. Shorter when the record is thin.
- "context" is up to 4 short bullets of specific things worth remembering going in. Only points
  the data supports. Two true bullets beat four padded ones, and an empty array is allowed.
- "starters" is 2-3 openers, each specific to THIS person and sayable out loud. A generic opener
  that would work for anyone is a failure, and so is one that assumes a shared past the record
  does not show.
- "watchOut" is one short sentence: the single thing most likely to make this land badly. If the
  record is too thin to say anything real, say that plainly.
- Plain text throughout. No markdown.

Respond with ONLY valid JSON, no markdown, no preamble, matching exactly:
{
  "summary": "...",
  "context": ["...", "..."],
  "starters": ["...", "..."],
  "watchOut": "..."
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              context: { type: "array", items: { type: "string" } },
              starters: { type: "array", items: { type: "string" } },
              watchOut: { type: "string" },
            },
            required: ["summary", "context", "starters", "watchOut"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write this brief." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to write a meeting brief.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/meeting/debrief
// body: { contact: {...}, survey: {...}, whatHappened: string }
//
// The other half of the same feature: the user types roughly what happened, and gets back a
// tidied note to save on the contact plus one concrete follow-up.
// ---------------------------------------------------------------------------
app.post("/api/meeting/debrief", async (req, res) => {
  try {
    const { contact = null, survey = {}, whatHappened = "" } = req.body || {};
    if (!contact || !contact.name) {
      return res.status(400).json({ error: "contact is required." });
    }
    if (!whatHappened.trim()) {
      return res.status(400).json({ error: "Tell me what happened first." });
    }

    const goalLabel = survey.goal === "Other" ? survey.otherGoal || "" : survey.goal || "";

    const prompt = `Someone has just finished a conversation with a person in their professional network and is writing it up.

THE PERSON THEY SPOKE TO
- Name: ${contact.name}
- Role: ${contact.role || "not on file"}
- Company: ${contact.company || "not on file"}

THE USER
- Name: ${survey.fullName || "not specified"}
- Career goal: ${goalLabel || "not specified"}

WHAT THEY SAID HAPPENED (their own words, possibly rough)
${whatHappened.trim()}

Turn this into a record they'll still understand in six months. Rules:
- Work ONLY from what they wrote. Do not add events, names, commitments, or details they did not mention.
- "note" is a tidied 2-4 sentence version of what happened, written in the user's voice, past tense. This gets saved onto the contact, so it should read as a record, not a summary of a summary.
- "keyPoints" is 1-4 short bullets of the facts worth remembering — things learned, commitments made, people mentioned. Empty array if they wrote too little to pull any out.
- "followUp" is one specific next action, phrased as an instruction to the user ("Send her the deck you mentioned", "Check back in three weeks"). Base it on what they actually wrote.
- "followUpDays" is how many days from now that follow-up should happen — an integer between 1 and 180.
- Plain text throughout. No markdown.

Respond with ONLY valid JSON, no markdown, no preamble, matching exactly:
{
  "note": "...",
  "keyPoints": ["...", "..."],
  "followUp": "...",
  "followUpDays": 14
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              note: { type: "string" },
              keyPoints: { type: "array", items: { type: "string" } },
              followUp: { type: "string" },
              followUpDays: { type: "integer" },
            },
            required: ["note", "keyPoints", "followUp", "followUpDays"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write this up." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to write up this conversation.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/brief
// body: { name, title, company, notes, interactions: [{date, type}] (<=3), eventTitle, eventTime, aim }
//
// Session 125. The row-level brief: a "Brief" tap on a Today/Coming up row that matched to a
// person, not the full-screen /api/meeting/brief above. The payload is deliberately narrower —
// exactly the fields the app's privacy rule names for this feature (see ROW_BRIEF_SENDS_LINE in
// the client) — three logged interactions rather than twenty, no warmth, no industry/school/
// location/categories, no occasion field. NO REQUEST BODY IS LOGGED, on this endpoint or any
// other in this file: only logUsage's token counts and classifyUpstream's error object ever
// reach console output.
// ---------------------------------------------------------------------------
app.post("/api/brief", async (req, res) => {
  try {
    const {
      name = "",
      title = "",
      company = "",
      notes = "",
      interactions = [],
      eventTitle = "",
      eventTime = "",
      aim = "",
    } = req.body || {};
    if (!name.trim()) {
      return res.status(400).json({ error: "name is required." });
    }

    const historyLines =
      Array.isArray(interactions) && interactions.length > 0
        ? interactions
            .slice(0, 3)
            .map((i) => `- ${i.date || "date unknown"}: ${i.type || "Contact"}`)
            .join("\n")
        : "- NOTHING LOGGED. There is no record of these two ever having been in contact.";

    const prompt = `You are writing a very short pre-meeting brief for someone about to meet a person in their professional network. This is for a single row on their home screen, not a full report — it has room for at most four short lines.

THE PERSON THEY ARE MEETING
- Name: ${name}
- Title: ${title || "not on file"}
- Company: ${company || "not on file"}

THEIR OWN NOTES ON THIS PERSON
${notes.trim() || "(none)"}

THEIR LAST THREE LOGGED INTERACTIONS WITH THIS PERSON, most recent first (there may be fewer than three, or none)
${historyLines}

THE MEETING THIS BRIEF IS FOR
${eventTitle || "Untitled event"}, at ${eventTime || "an unknown time"}.

WHAT THE USER IS GENERALLY AIMING AT
${aim.trim() || "not specified"}

DO NOT GUESS ABOUT THIS PERSON. You have been given everything the app knows about them, which
is often very little. A field marked "not on file" is a fact, not an invitation to infer one — do
not guess their seniority, what their company does, or anything else not stated above. Do not
invent a shared history beyond what the interactions list actually shows, and do not assume they
have met before if nothing is logged.

Write at most 4 short lines. Each line is either a fact drawn from the record above, or a
suggestion for the meeting phrased as one — never a generic line that would fit any meeting with
anyone. Fewer than 4 lines is correct when the record does not support more; an empty list is
correct when there is nothing to say. Plain text, sentence case, no em dashes, no exclamation
marks, no markdown.

Respond with ONLY valid JSON, no markdown formatting, no code fences, no preamble, matching
exactly this shape:
{
  "lines": ["...", "..."]
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              lines: { type: "array", items: { type: "string" } },
            },
            required: ["lines"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write this brief." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to write a meeting brief.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/brief-lines
// body: { aim: string, companies: string[] } (<=8, deduplicated, most frequent first)
//
// Session 125b, Part 1. A SEPARATE ENDPOINT FROM /api/brief ABOVE, not a mode on it — /api/brief
// already has one fully-specified, field-tested body shape (RowBriefInput) and a mode branch
// would mean two body shapes behind the same tests. This one carries no person at all: never a
// name, a title, a company tied to a specific contact, or anything from an interaction log. Just
// the user's stated aim and up to eight company names, already deduplicated and capped by the
// client (store/briefWebLines.ts's topCompanies). NO REQUEST BODY IS LOGGED.
//
// USES THE WEB SEARCH TOOL, deliberately WITHOUT output_config's json_schema format: the two are
// documented as incompatible with citations, and a web-search turn attaches citations to its own
// text blocks by default. The prompt instead asks, in plain language, for the model's LAST
// message to contain nothing but the JSON — the same technique session 60's early endpoints used
// before output_config existed. Verified by hand (see SESSION_125B_FINDINGS.md): the model's
// final text block was clean JSON with no narration in every trial run.
// ---------------------------------------------------------------------------
app.post("/api/brief-lines", async (req, res) => {
  try {
    const { aim = "", companies = [] } = req.body || {};
    const companyList = (Array.isArray(companies) ? companies : [])
      .filter((c) => typeof c === "string" && c.trim() !== "")
      .slice(0, 8);

    const prompt = `You are writing at most two short factual lines for the brief tile on the home screen of a professional networking app. Below is the user's stated aim and a short list of company names drawn from people already in their professional network. No person's name, title or anything about an individual is included here — only the aim and the company list.

USER'S AIM
${aim.trim() || "not specified"}

COMPANIES IN THEIR NETWORK
${companyList.length > 0 ? companyList.join(", ") : "(none on file)"}

Search the web for at most two facts. Each fact must be either about one of the companies listed above, or about roles or hiring matching the aim — NEVER about a specific person, by name or otherwise. Each fact must be dated within the last 14 days; if you cannot find anything that recent, leave it out rather than using an older or invented fact. An empty list is the correct answer on a day with nothing to report.

Write each fact as one short sentence in the app's voice: sentence case, no em dashes, no exclamation marks, understated rather than promotional.

After you finish searching, your LAST message must contain ONLY the JSON below and nothing else — no narration, no caveats, no code fences, no markdown, before or after it:
{
  "lines": [
    { "text": "...", "url": "...", "title": "..." }
  ]
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2000,
      thinking: { type: "adaptive" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 4 }],
      messages: [{ role: "user", content: prompt }],
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write the brief's web lines." });
    }

    const textBlocks = response.content.filter((b) => b.type === "text");
    const last = textBlocks[textBlocks.length - 1];
    if (!last) return res.status(502).json({ error: "No text content returned from the model." });

    let parsed;
    try {
      parsed = JSON.parse(last.text);
    } catch {
      return res.status(502).json({ error: "The model's response was not valid JSON." });
    }

    // A line without a working URL is dropped here — never forwarded for the app to guess a
    // domain from nothing. `domain` is computed here, from Node's own URL parser, rather than
    // trusted from the model's own formatting of it.
    const lines = (Array.isArray(parsed?.lines) ? parsed.lines : [])
      .map((l) => {
        if (!l || typeof l.text !== "string" || typeof l.url !== "string") return null;
        let domain;
        try {
          domain = new URL(l.url).hostname.replace(/^www\./, "");
        } catch {
          return null;
        }
        if (l.text.trim() === "" || domain === "") return null;
        return { text: l.text.trim(), url: l.url, domain, title: typeof l.title === "string" ? l.title.trim() : "" };
      })
      .filter(Boolean)
      .slice(0, 2);

    res.json({ lines });
  } catch (err) {
    failed(res, req.path, err, "Failed to write the brief's web lines.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/next-step
// body: { aim: string, people: [{ name, title, company, lastLogged }] } (<=5)
//
// Session 125b, Part 2. Home's "Next step" half tile: one sentence naming one person from the
// user's network whose title or company relates to their stated aim, plus one concrete thing to
// ask or say. NO WEB SEARCH — this reads only what the app already knows about its own people,
// the same shape of call as /api/brief, so output_config's json_schema format is used here (no
// citations conflict). NO REQUEST BODY IS LOGGED.
// ---------------------------------------------------------------------------
app.post("/api/next-step", async (req, res) => {
  try {
    const { aim = "", people = [] } = req.body || {};
    const candidates = (Array.isArray(people) ? people : [])
      .filter((p) => p && typeof p.name === "string" && p.name.trim() !== "")
      .slice(0, 5);
    if (candidates.length === 0) {
      return res.status(400).json({ error: "people is required." });
    }

    const peopleLines = candidates
      .map(
        (p, i) =>
          `${i + 1}. ${p.name} — ${p.title || "role not on file"} at ${p.company || "company not on file"}. Last logged: ${p.lastLogged || "never"}.`
      )
      .join("\n");

    const prompt = `You are suggesting one next step for someone managing their professional network. Below is their stated aim and up to five people already in their network whose title or company relates to it.

THEIR AIM
${aim.trim() || "not specified"}

PEOPLE WHOSE TITLE OR COMPANY RELATES TO IT
${peopleLines}

Write ONE sentence naming exactly one of the people listed above by their EXACT name as given, with one concrete thing to ask or say to them, in a plain, understated voice: sentence case, no em dashes, no exclamation marks. Base it only on what is stated above — never invent a detail about the person, their role, their company or a shared history that isn't in the list.

Respond with ONLY valid JSON, no markdown formatting, no code fences, no preamble, matching exactly this shape:
{
  "line": "...",
  "personName": "..."
}
"personName" must be copied exactly, character for character, from one of the names in the list above.`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1000,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              line: { type: "string" },
              personName: { type: "string" },
            },
            required: ["line", "personName"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write a next step." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    const parsed = JSON.parse(textBlock.text);

    // The name must be one of the candidates verbatim — never trusted otherwise. The app
    // resolves it back to a contact by exact match against the same list it sent.
    const known = candidates.some((p) => p.name === parsed.personName);
    if (!known) {
      return res.status(502).json({ error: "The model named someone not on the list." });
    }

    res.json(parsed);
  } catch (err) {
    failed(res, req.path, err, "Failed to write a next step.");
  }
});

// ---------------------------------------------------------------------------
// POST /api/birthday-message
// body: { firstName, relationship, title, company, notes, activities: [{ type, date }] } (<=3)
//
// Session 125b, Part 3. The fourth row in BirthdaySheet.tsx's picker, "Written for <First>":
// one birthday message, at most 40 words, built from what is on record about the person and how
// the user knows them. No web search, same shape as /api/brief and /api/next-step.
// NO REQUEST BODY IS LOGGED.
// ---------------------------------------------------------------------------
app.post("/api/birthday-message", async (req, res) => {
  try {
    const { firstName = "", relationship = "", title = "", company = "", notes = "", activities = [] } = req.body || {};
    if (!firstName.trim()) {
      return res.status(400).json({ error: "firstName is required." });
    }

    const activityLines =
      Array.isArray(activities) && activities.length > 0
        ? activities
            .slice(0, 3)
            .map((a) => `- ${a.date || "date unknown"}: ${a.type || "Contact"}`)
            .join("\n")
        : "- Nothing logged with them yet.";

    const prompt = `You are writing one short birthday text message for the user to send to somebody in their professional network. Below is everything on record about that person.

FIRST NAME
${firstName}

HOW THE USER KNOWS THEM
${relationship || "not specified"}

TITLE AND COMPANY
${title || "not on file"}${company ? ` at ${company}` : ""}

THE USER'S OWN NOTES ON THEM
${notes.trim() || "(none)"}

LAST LOGGED INTERACTIONS WITH THEM, most recent first
${activityLines}

Write ONE birthday message, at most 40 words, warm, in the second person, as if the user is writing it themselves. You may mention at most one specific thing drawn from what is on record above — never invent a detail, a shared memory, a plan or anything not stated. One exclamation mark is allowed; use no more than one. Sentence case, no em dashes.

Respond with ONLY valid JSON, no markdown formatting, no code fences, no preamble, matching exactly this shape:
{
  "message": "..."
}`;

    const startedAt = Date.now();
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 800,
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: prompt }],
      output_config: {
        format: {
          type: "json_schema",
          schema: {
            type: "object",
            properties: {
              message: { type: "string" },
            },
            required: ["message"],
            additionalProperties: false,
          },
        },
      },
    });

    logUsage(req.path, response, startedAt);

    if (response.stop_reason === "refusal") {
      return res.status(422).json({ error: "The model declined to write this one." });
    }

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock) return res.status(502).json({ error: "No text content returned from the model." });
    res.json(JSON.parse(textBlock.text));
  } catch (err) {
    failed(res, req.path, err, "Failed to write this one.");
  }
});

app.listen(PORT, () => {
  console.log(`network-app-server listening on http://localhost:${PORT}`);
});

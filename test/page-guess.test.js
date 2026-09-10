// Drafting a contact from a web page (the Add to Orbit bookmarklet).

const test = require("node:test");
const assert = require("node:assert/strict");
const { guessFromPage, cleanTitle } = require("../src/shared/page-guess");

test("LinkedIn profile: name, role, company and a clean profile link", () => {
  const g = guessFromPage({
    url: "https://www.linkedin.com/in/jane-doe-123/?originalSubdomain=uk",
    title: "(2) Jane Doe - CTO - Acme Corp | LinkedIn",
    og: "Jane Doe - CTO - Acme Corp | LinkedIn",
    site: "LinkedIn",
    text: "",
  });
  assert.equal(g.isLinkedIn, true);
  assert.equal(g.name, "Jane Doe");
  assert.equal(g.fields.role, "CTO");
  assert.equal(g.fields.company, "Acme Corp");
  assert.equal(g.fields.linkedin, "https://www.linkedin.com/in/jane-doe-123");
  assert.equal("website" in g.fields, false);
  assert.equal("notes" in g.fields, false);
});

test("any other page: title is the name, site is the company, address is the website", () => {
  const g = guessFromPage({
    url: "https://example.com/team/sam",
    title: "Sam Lee | Example Co",
    site: "Example Co",
    text: "Reach Sam at sam@example.com or +44 20 7946 0000 about the pilot.",
  });
  assert.equal(g.name, "Sam Lee");
  assert.equal(g.fields.company, "Example Co");
  assert.equal("website" in g.fields, false, "the page address is not a fact about the person");
  assert.equal(g.fields.email, "sam@example.com");
  assert.equal(g.fields.phone, "+44 20 7946 0000");
  assert.match(g.fields.notes, /about the pilot/);
  assert.equal(g.source, "Example Co");
});

test("a short selection is the name; a long one is notes", () => {
  const short = guessFromPage({ url: "https://news.example.com/story", title: "Big story | News", text: "Priya Natarajan" });
  assert.equal(short.name, "Priya Natarajan");
  assert.equal("notes" in short.fields, false);
  const long = guessFromPage({ url: "https://news.example.com/story", title: "Big story | News", text: "Priya Natarajan spoke at length about the merger and the team behind it, then left." });
  assert.equal(long.name, "Big story");
  assert.match(long.fields.notes, /spoke at length/);
});

test("empty or odd input never throws and yields an empty draft", () => {
  assert.deepEqual(guessFromPage({}), { name: "", fields: {}, source: "", isLinkedIn: false });
  const g = guessFromPage({ url: "not a url", title: "Orbit", site: "Orbit" });
  assert.equal(g.name, "Orbit");
  assert.equal("company" in g.fields, false, "a site named like the page adds nothing");
  assert.equal(cleanTitle("(12) Hello · Somewhere"), "Hello");
});

const ist = require("ist")
const {Tag, TagMatch} = require("..")

describe("Tag", () => {
  it("splits on dots", () => {
    ist(JSON.stringify(new Tag("foo.bar.baz").parts), '["baz","bar","foo"]')
  })

  it("handles properties", () => {
    let t = new Tag("foo.lang=css.something=other")
    ist(JSON.stringify(t.parts), '["foo"]')
    ist(JSON.stringify(t.properties), '["lang","css","something","other"]')
  })

  it("handles quoted values", () => {
    ist(JSON.stringify(new Tag('foo.bar="bar bug\\"".baz').properties), '["bar","bar bug\\""]')
  })

  it("matches when their parts are a suffix", () => {
    ist(new Tag("a.b.c").match(new Tag("b.c")))
    ist(!new Tag("a.b.c").match(new Tag("a.b")))
  })

  it("matches properties", () => {
    ist(new Tag("a.b.c=10").match(new Tag("b.c=10")))
    ist(!new Tag("a.b.c=10").match(new Tag("b.c=11")))
  })

  it("assigns specificity based on parts and properties", () => {
    ist(new Tag("a.b").specificity, 2)
    ist(new Tag("a.b.c").specificity, 3)
    ist(new Tag("a.x=1.y=2").specificity, 3)
  })
})

describe("TagMatch", () => {
  it("returns the most specific match", () => {
    let m = new TagMatch({
      "foo.bar": 1,
      "bar": 2
    })
    ist(m.best(new Tag("foo.bar")), 1)
    ist(m.best(new Tag("quux.bar")), 2)
    ist(m.best(new Tag("foo.baz")), null)
  })

  it("can match parents", () => {
    let m = new TagMatch({"one three": 1, "one two three": 2})
    ist(m.best(new Tag("three")), null)
    ist(m.best(new Tag("three"), [new Tag("one")]), 1)
    ist(m.best(new Tag("three"), [new Tag("one"), new Tag("two")]), 2)
  })

  it("parses strings properly", () => {
    let m = new TagMatch({"a.b=\"foo bar\"": 1})
    ist(m.best(new Tag("z.a.b=\"foo bar\"")), 1)
  })

  it("sorts matches", () => {
    let m = new TagMatch({"c": 1, "a.b.c": 2, "b.c": 3, "e": 4})
    ist(JSON.stringify(m.all(new Tag("a.b.c"))), "[2,3,1]")
    ist(JSON.stringify(m.all(new Tag("c.e"))), "[4]")
  })

  it("allows multiple selectors per rule", () => {
    let m = new TagMatch({"a.b, c": 1, "d": 2})
    ist(m.best(new Tag("a.b")), 1)
    ist(m.best(new Tag("c")), 1)
    ist(m.best(new Tag("d")), 2)
  })

  it("handles direct child selectors", () => {
    let m = new TagMatch({"a > b": 1})
    ist(m.best(new Tag("b"), [new Tag("a")]), 1)
    ist(m.best(new Tag("b"), [new Tag("a"), new Tag("c")]), null)
  })
})

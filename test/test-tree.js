const ist = require("ist")
const {Tag, TagMatch} = require("..")

describe("Tag", () => {
  it("splits on dots", () => {
    ist(JSON.stringify(new Tag("foo.bar.baz").parts), '["foo","","bar","","baz",""]')
  })

  it("handles values", () => {
    ist(JSON.stringify(new Tag("foo.lang=css.something=other").parts), '["foo","","lang","css","something","other"]')
  })

  it("handles quoted values", () => {
    ist(JSON.stringify(new Tag('foo.bar="bar bug\\"".baz').parts), '["foo","","bar","bar bug\\"","baz",""]')
  })

  it("matches when all pieces are present", () => {
    ist(new Tag("a.b.c").match(new Tag("a.b")))
    ist(!new Tag("a.b.c").match(new Tag("a.d")))
  })

  it("matches values", () => {
    ist(new Tag("a.b.c=10").match(new Tag("a.c=10")))
    ist(!new Tag("a.b.c=10").match(new Tag("a.c=11")))
  })

  it("assigns higher scores to more specific matches", () => {
    let abc = new Tag("a=x.b.c")
    ist(abc.match(new Tag("a.b")), abc.match(new Tag("b.c")), ">")
    ist(abc.match(new Tag("a.b.c")), abc.match(new Tag("a.b")), ">")
    ist(abc.match(new Tag("a=x")), abc.match(new Tag("a")), ">")
  })
})

describe("TagMatch", () => {
  it("returns the most specific match", () => {
    let m = new TagMatch({
      "foo.bar": 1,
      "bar": 2
    })
    ist(m.best(new Tag("foo.bar.baz")), 1)
    ist(m.best(new Tag("oo.bar.baz")), 2)
    ist(m.best(new Tag("oo.ar.baz")), null)
  })

  it("can match parents", () => {
    let m = new TagMatch({"one three": 1, "one two three": 2})
    ist(m.best(new Tag("three")), null)
    ist(m.best(new Tag("three"), [new Tag("one")]), 1)
    ist(m.best(new Tag("three"), [new Tag("one"), new Tag("two")]), 2)
  })

  it("parses strings properly", () => {
    let m = new TagMatch({"a=\"foo bar\".b": 1})
    ist(m.best(new Tag("a=\"foo bar\".b.c")), 1)
  })

  it("sorts matches", () => {
    let m = new TagMatch({"c": 1, "a.b.c": 2, "b.c": 3, "e": 4})
    ist(JSON.stringify(m.all(new Tag("a.b.c"))), "[2,3,1]")
    ist(JSON.stringify(m.all(new Tag("c.e"))), "[1,4]")
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

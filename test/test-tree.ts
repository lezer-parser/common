import {Tree, NodeGroup, NodeType, TreeCursor} from ".."
import ist from "ist"

let types = "T a b c Pa Br".split(" ").map((s, i) => new (NodeType as any)(s, {}, i))
let repeat = new (NodeType as any)("", {}, types.length)
types.push(repeat)
let group = new NodeGroup(types)

function id(n: string) { return types.find(x => x.name == n)!.id }

function mk(spec: string) {
  let starts: number[] = [], buffer: number[] = []
  for (let pos = 0; pos < spec.length;) {
    let [m, letters, open, close] = /^(?:([abc]+)|([\[\(])|([\]\)]))/.exec(spec.slice(pos))!
    if (letters) {
      let bufStart = buffer.length
      for (let i = 0; i < letters.length; i++) {
        buffer.push(id(letters[i]), pos + i, pos + i + 1, 4)
        if (i) buffer.push(repeat.id, pos, pos + i + 1, (buffer.length + 4) - bufStart)
      }
    } else if (open) {
      starts.push(buffer.length, pos)
    } else {
      buffer.push(id(close == ")" ? "Pa" : "Br"), starts.pop()!, pos + 1, (buffer.length + 4) - starts.pop()!)
    }
    pos += m.length
  }
  return Tree.build({buffer, group, topID: 0, maxBufferLength: 10, minRepeatType: repeat.id})
}

let _recur: Tree | null = null
function recur() {
  return _recur || (_recur = mk(function build(depth: number): string {
    if (depth) {
      let inner = build(depth - 1)
      return "(" + inner + ")[" + inner + "]"
    } else {
      let result = ""
      for (let i = 0; i < 20; i++) result += "abc"[i % 3]
      return result
    }
  }(6)))
}

let _simple: Tree | null = null
function simple() {
  return _simple || (_simple = mk("aaaa(bbb[ccc][aaa][()])"))
}

describe("resolve", () => {
  it("can resolve at the top level", () => {
    let tr = simple().resolve(2, -1)
    ist(tr.start, 1)
    ist(tr.end, 2)
    ist(tr.name, "a")
    tr = tr.parent()!
    ist(tr.name, "T")
    ist(tr.parent(), null)
    tr = simple().resolve(2, 1)
    ist(tr.start, 2)
    ist(tr.end, 3)
    tr = simple().resolve(2)
    ist(tr.name, "T")
    ist(tr.start, 0)
    ist(tr.end, 23)
  })

  it("can resolve deeper", () => {
    let tr = simple().resolve(10, 1)
    ist(tr.name, "c")
    ist(tr.start, 10)
    tr = tr.parent()!
    ist(tr.name, "Br")
    tr = tr.parent()!
    ist(tr.name, "Pa")
    ist(tr.parent()!.name, "T")
  })

  it("can resolve into a parent node", () => {
    let tr = simple().resolve(10).moveTo(2)
    ist(tr.name, "T")
  })

  it("can resolve in a large tree", () => {
    let tr = recur().resolve(10, 1)
    ist(tr.depth, 7)
  })

  it("caches resolved parents", () => {
    ist(recur().resolve(10, 1).parent, recur().resolve(13, 1).parent)
  })
})

describe("cursor", () => {
  const simpleCount: Record<string, number> = {a: 7, b: 3, c: 3, Br: 3, Pa: 2, T: 1}

  it("iterates over all nodes", () => {
    let count: Record<string, number> = Object.create(null)
    let pos = 0
    for (let cur: TreeCursor | null = simple().cursor(); cur; cur = cur.next()) {
      ist(cur.start, pos, ">=")
      pos = cur.start
      count[cur.name] = (count[cur.name] || 0) + 1
    }
    for (let k of Object.keys(simpleCount)) ist(count[k], simpleCount[k])
  })

  it("iterates over all nodes in reverse", () => {
    let count: Record<string, number> = Object.create(null)
    let pos = 100
    for (let cur: TreeCursor | null = simple().cursor(); cur; cur = cur.prev()) {
      ist(cur.end, pos, "<=")
      pos = cur.end
      count[cur.name] = (count[cur.name] || 0) + 1
    }
    for (let k of Object.keys(simpleCount)) ist(count[k], simpleCount[k])
  })

  it("can leave nodes", () => {
    let cur = simple().cursor()
    ist(!cur.parent())
    cur = cur.next()!.next()!
    ist(cur.start, 1)
    ist(cur = cur.clone().parent()!)
    ist(cur.start, 0)
    for (let j = 0; j < 6; j++) cur = cur.next()!
    ist(cur.start, 5)
    ist(cur = cur.clone().parent()!)
    ist(cur.start, 4)
    ist(cur = cur.clone().parent()!)
    ist(cur.start, 0)
    ist(!cur.parent())
  })

  it("can move to a given position", () => {
    let tree = recur(), start = tree.length >> 1, cursor: TreeCursor | null = tree.cursor().moveTo(start, 1)
    do { ist(cursor.start, start, ">=") }
    while (cursor = cursor.next())
  })

  it("isn't slow", () => {
    let tree = recur(), t0 = Date.now(), count = 0
    for (let i = 0; i < 2000; i++)
      for (let cur: TreeCursor | null = tree.cursor(); cur; cur = cur.next()) {
        if (cur.start < 0 || !cur.name) throw new Error("BAD")
        count++
      }
    let perMS = count / (Date.now() - t0)
    console.log(perMS, "/ms")
    ist(perMS, 10000, ">")
  })
})

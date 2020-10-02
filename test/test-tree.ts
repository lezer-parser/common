import {Tree, NodeGroup, NodeType} from ".."
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
  }(5)))
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
    ist(tr.parent!.name, "T")
    ist(tr.parent!.parent, null)
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
    ist(tr.parent!.name, "Br")
    ist(tr.parent!.parent!.name, "Pa")
    ist(tr.parent!.parent!.parent!.name, "T")
  })

  it("can resolve into a parent node", () => {
    let tr = simple().resolve(10).resolve(2)
    ist(tr.name, "T")
  })

  it("can resolve in a large tree", () => {
    let tr = recur().resolve(10, 1)
    ist(tr.depth, 6)
  })

  it("caches resolved parents", () => {
    ist(recur().resolve(10, 1).parent, recur().resolve(13, 1).parent)
  })

  it("can take first and last children", () => {
    let tr = simple().resolve(6)
    ist(tr.firstChild!.name, "b")
    ist(tr.firstChild!.start, 5)
    ist(tr.lastChild!.name, "Br")
    ist(tr.lastChild!.end, 22)
  })

  it("can find children at a given position", () => {
    let tr = simple().resolve(13)
    ist(tr.childBefore(5), null)
    ist(tr.childBefore(6)!.name, "b")
    ist(tr.childBefore(10000)!.name, "Br")
    ist(tr.childAfter(0)!.name, "b")
    ist(tr.childAfter(13)!.start, 13)
    ist(tr.childAfter(22), null)
  })
})

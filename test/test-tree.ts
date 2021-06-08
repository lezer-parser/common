import {Tree, NodeSet, NodeType, SyntaxNode, NodeProp} from ".."
import ist from "ist"

let types = "T a b c Pa Br".split(" ").map((s, i) => NodeType.define({
  id: i,
  name: s,
  props: /^[abc]$/.test(s) ? [[NodeProp.group, ["atom"]]] : []
}))
let repeat = NodeType.define({id: types.length})
types.push(repeat)
let nodeSet = new NodeSet(types)

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
  return Tree.build({buffer, nodeSet, topID: 0, maxBufferLength: 10, minRepeatType: repeat.id})
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

const anonTree = new Tree(nodeSet.types[0], [
  new Tree(NodeType.none, [
    new Tree(nodeSet.types[1], [], [], 1),
    new Tree(nodeSet.types[2], [], [], 1)
  ], [0, 1], 2),
], [0], 2)

describe("SyntaxNode", () => {
  it("can resolve at the top level", () => {
    let c = simple().resolve(2, -1)
    ist(c.from, 1)
    ist(c.to, 2)
    ist(c.name, "a")
    ist(c.parent!.name, "T")
    ist(!c.parent!.parent)
    c = simple().resolve(2, 1)
    ist(c.from, 2)
    ist(c.to, 3)
    c = simple().resolve(2)
    ist(c.name, "T")
    ist(c.from, 0)
    ist(c.to, 23)
  })

  it("can resolve deeper", () => {
    let c = simple().resolve(10, 1)
    ist(c.name, "c")
    ist(c.from, 10)
    ist(c.parent!.name, "Br")
    ist(c.parent!.parent!.name, "Pa")
    ist(c.parent!.parent!.parent!.name, "T")
  })

  it("can resolve in a large tree", () => {
    let c: SyntaxNode | null = recur().resolve(10, 1), depth = 1
    while (c = c.parent) depth++
    ist(depth, 8)
  })

  it("caches resolved parents", () => {
    let a = recur().resolve(3, 1), b = recur().resolve(3, 1)
    ist(a, b)
  })

  describe("getChild", () => {
    function flat(children: readonly SyntaxNode[]) {
      return children.map(c => c.name).join(",")
    }

    it("can get children by group", () => {
      let tree = mk("aa(bb)[aabbcc]").topNode
      ist(flat(tree.getChildren("atom")), "a,a")
      ist(flat(tree.firstChild!.getChildren("atom")), "")
      ist(flat(tree.lastChild!.getChildren("atom")), "a,a,b,b,c,c")
    })

    it("can get single children", () => {
      let tree = mk("abc()").topNode
      ist(tree.getChild("Br"), null)
      ist(tree.getChild("Pa")?.name, "Pa")
    })

    it("can get children between others", () => {
      let tree = mk("aa(bb)[aabbcc]").topNode
      ist(tree.getChild("Pa", "atom", "Br"))
      ist(!tree.getChild("Pa", "atom", "atom"))
      let last = tree.lastChild!
      ist(flat(last.getChildren("b", "a", "c")), "b,b")
      ist(flat(last.getChildren("a", null, "c")), "a,a")
      ist(flat(last.getChildren("c", "b", null)), "c,c")
      ist(flat(last.getChildren("b", "c")), "")
    })
  })

  it("skips anonymous nodes", () => {
    ist(anonTree + "", "T(a,b)")
    ist(anonTree.resolve(1).name, "T")
    ist(anonTree.topNode.lastChild!.name, "b")
    ist(anonTree.topNode.firstChild!.name, "a")
    ist(anonTree.topNode.childAfter(1)!.name, "b")
  })

  it("enters mounted trees", () => {
    let tree = mk("aaa[bbbbbbbbbb]aaa")
    let node = tree.topNode.childAfter(3)!.tree
    ist(node instanceof Tree)
    ;(node as any).props = Object.create(null)
    ;(node as any).props[(NodeProp.mountedTree as any).id] = mk("((cccccccc))")
    ist(tree.toString(), "T(a,a,a,T(Pa(Pa(c,c,c,c,c,c,c,c))),a,a,a)")
    ist(tree.topNode.childAfter(3)!.name, "T")
    ist(tree.resolve(5, 1).name, "c")
    ist(tree.topNode.childAfter(3)!.parent!.name, "T")
  })
})

describe("TreeCursor", () => {
  const simpleCount: Record<string, number> = {a: 7, b: 3, c: 3, Br: 3, Pa: 2, T: 1}

  it("iterates over all nodes", () => {
    let count: Record<string, number> = Object.create(null)
    let pos = 0, cur = simple().cursor()
    do {
      ist(cur.from, pos, ">=")
      pos = cur.from
      count[cur.name] = (count[cur.name] || 0) + 1
    } while (cur.next())
    for (let k of Object.keys(simpleCount)) ist(count[k], simpleCount[k])
  })

  it("iterates over all nodes in reverse", () => {
    let count: Record<string, number> = Object.create(null)
    let pos = 100, cur = simple().cursor()
    do {
      ist(cur.to, pos, "<=")
      pos = cur.to
      count[cur.name] = (count[cur.name] || 0) + 1
    } while (cur.prev())
    for (let k of Object.keys(simpleCount)) ist(count[k], simpleCount[k])
  })

  it("works with internal iteration", () => {
    let openCount: Record<string, number> = Object.create(null)
    let closeCount: Record<string, number> = Object.create(null)
    simple().iterate({
      enter(t) { openCount[t.name] = (openCount[t.name] || 0) + 1 },
      leave(t) { closeCount[t.name] = (closeCount[t.name] || 0) + 1 }
    })
    for (let k of Object.keys(simpleCount)) {
      ist(openCount[k], simpleCount[k])
      ist(closeCount[k], simpleCount[k])
    }
  })

  it("handles iterating out of bounds", () => {
    let hit = 0
    Tree.empty.iterate({
      from: 0,
      to: 200,
      enter() { hit++ },
      leave() { hit++ }
    })
    ist(hit, 0)
  })

  it("internal iteration can be limited to a range", () => {
    let seen: string[] = []
    simple().iterate({
      enter(t) { seen.push(t.name); return t.name == "Br" ? false : undefined },
      from: 3,
      to: 14
    })
    ist(seen.join(","), "T,a,a,Pa,b,b,b,Br,Br")
  })

  it("can leave nodes", () => {
    let cur = simple().cursor()
    ist(!cur.parent())
    cur.next(); cur.next()
    ist(cur.from, 1)
    ist(cur.parent())
    ist(cur.from, 0)
    for (let j = 0; j < 6; j++) cur.next()
    ist(cur.from, 5)
    ist(cur.parent())
    ist(cur.from, 4)
    ist(cur.parent())
    ist(cur.from, 0)
    ist(!cur.parent())
  })

  it("can move to a given position", () => {
    let tree = recur(), start = tree.length >> 1, cursor = tree.cursor(start, 1)
    do { ist(cursor.from, start, ">=") }
    while (cursor.next())
  })

  it("can move into a parent node", () => {
    let c = simple().cursor(10).moveTo(2)
    ist(c.name, "T")
  })

  it("can move to a specific sibling", () => {
    let cursor = simple().cursor()
    ist(cursor.childAfter(2))
    ist(cursor.to, 3)
    cursor.parent()
    ist(cursor.childBefore(5))
    ist(cursor.from, 4)
    ist(cursor.childAfter(11))
    ist(cursor.from, 8)
    ist(cursor.childBefore(10))
    ist(cursor.from, 9)
    ist(!simple().cursor().childBefore(0))
    ist(!simple().cursor().childAfter(100))
  })

  it("isn't slow", () => {
    let tree = recur(), t0 = Date.now(), count = 0
    for (let i = 0; i < 2000; i++) {
      let cur = tree.cursor()
      do {
        if (cur.from < 0 || !cur.name) throw new Error("BAD")
        count++
      } while (cur.next())
    }
    let perMS = count / (Date.now() - t0)
    ist(perMS, 10000, ">")
  })

  it("can produce nodes", () => {
    let node = simple().cursor(8, 1).node
    ist(node.name, "Br")
    ist(node.from, 8)
    ist(node.parent!.name, "Pa")
    ist(node.parent!.from, 4)
    ist(node.parent!.parent!.name, "T")
    ist(node.parent!.parent!.from, 0)
    ist(node.parent!.parent!.parent, null)
  })

  it("can produce node from cursors created from nodes", () => {
    let cur = simple().topNode.lastChild!.childAfter(8)!.childAfter(10)!.cursor
    ist(cur.name, "c")
    ist(cur.from, 10)
    ist(cur.parent())
    let node = cur.node
    ist(node.name, "Br")
    ist(node.from, 8)
    ist(node.parent!.name, "Pa")
    ist(node.parent!.from, 4)
    ist(node.parent!.parent!.name, "T")
    ist(node.parent!.parent!.parent, null)
  })

  it("reuses nodes in buffers", () => {
    let cur = simple().cursor(10, 1)
    let n10 = cur.node
    ist(n10.name, "c")
    ist(n10.from, 10)
    ist(cur.node, n10)
    cur.nextSibling()
    ist(cur.node.parent, n10.parent)
    cur.parent()
    ist(cur.node, n10.parent)
  })

  it("skips anonymous nodes", () => {
    let c = anonTree.cursor()
    c.moveTo(1)
    ist(c.name, "T")
    c.firstChild()
    ist(c.name, "a")
    c.nextSibling()
    ist(c.name, "b")
    ist(!c.next())
  })

  it("stops at anonymous nodes when configured as full", () => {
    let c = anonTree.fullCursor()
    c.moveTo(1)
    ist(c.type, NodeType.none)
    ist(c.tree!.length, 2)
    c.firstChild()
    ist(c.name, "a")
    c.parent()
    ist(c.type, NodeType.none)
  })
})

/**
 * Copyright 2013 Google, Inc.
 * Copyright 2015 Daishinsha Inc.
 * Copyright 2019 Vivliostyle Foundation
 *
 * Vivliostyle.js is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Vivliostyle.js is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Vivliostyle.js.  If not, see <http://www.gnu.org/licenses/>.
 *
 * @fileoverview XmlDoc - Utility functions to work with XML (mostly XHTML)
 * documents.
 */
import * as Base from "./base";
import * as Net from "./net";
import * as Task from "./task";
import { XmlDoc } from "./types";

export type XMLDocStore = XmlDoc.XMLDocStore;

export class XMLDocHolder implements XmlDoc.XMLDocHolder {
  lang: string | null = null;
  totalOffset: number = -1;
  root: Element;
  body: Element;
  head: Element;
  last: Element;
  lastOffset: number = 1;
  idMap: { [key: string]: Element };

  constructor(
    public readonly store: XMLDocStore,
    public readonly url: string,
    public readonly document: Document,
  ) {
    this.root = document.documentElement; // html element
    let body: Element = null;
    let head: Element = null;
    if (this.root.namespaceURI == Base.NS.XHTML) {
      for (
        let child: Node = this.root.firstChild;
        child;
        child = child.nextSibling
      ) {
        if (child.nodeType != 1) {
          continue;
        }
        const elem = child as Element;
        if (elem.namespaceURI == Base.NS.XHTML) {
          switch (elem.localName) {
            case "head":
              head = elem;
              break;
            case "body":
              body = elem;
              break;
          }
        }
      }
      this.lang = this.root.getAttribute("lang");
    }
    this.body = body as Element;
    this.head = head as Element;
    this.last = this.root;
    this.last.setAttribute(Base.ELEMENT_OFFSET_ATTR, "0");
  }

  doc(): XmlDoc.NodeList {
    return new NodeList([this.document]);
  }

  getElementOffset(element: Element): number {
    const offsetStr = element.getAttribute(Base.ELEMENT_OFFSET_ATTR);
    if (offsetStr) {
      return parseInt(offsetStr, 10);
    }
    let offset = this.lastOffset;
    let last: Node | null = this.last;
    while (last != element) {
      let next: Node | null = last.firstChild;
      if (!next) {
        while (true) {
          next = last.nextSibling;
          if (next) {
            break;
          }
          last = last.parentNode;
          if (last == null) {
            throw new Error("Internal error");
          }
        }
      }
      last = next;
      if (next.nodeType == 1) {
        const nextElement = next as Element;
        nextElement.setAttribute(Base.ELEMENT_OFFSET_ATTR, offset.toString());
        ++offset;
      } else {
        offset += (next.textContent as string).length;
      }
    }
    this.lastOffset = offset;
    this.last = element;
    return offset - 1;
  }

  getNodeOffset(srcNode: Node, offsetInNode: number, after: boolean) {
    let extraOffset = 0;
    let node: Node | null = srcNode;
    let prev: Node | null = null;
    if (node.nodeType == 1) {
      // after = true is only valid for elements
      if (!after) {
        return this.getElementOffset(node as Element);
      }
    } else {
      // offsetInNode is only valid for text nodes
      extraOffset = offsetInNode;
      prev = node.previousSibling;
      if (!prev) {
        node = node.parentNode;
        extraOffset += 1;
        return this.getElementOffset(node as Element) + extraOffset;
      }
      node = prev;
    }
    while (true) {
      while (node.lastChild) {
        node = node.lastChild;
      }
      if (node.nodeType == 1) {
        // empty element
        break;
      }
      extraOffset += (node.textContent as string).length;
      prev = node.previousSibling;
      if (!prev) {
        node = node.parentNode;
        break;
      }
      node = prev;
    }
    extraOffset += 1;
    return this.getElementOffset(node as Element) + extraOffset;
  }

  getTotalOffset(): number {
    if (this.totalOffset < 0) {
      this.totalOffset = this.getNodeOffset(this.root, 0, true);
    }
    return this.totalOffset;
  }

  /**
   * @return last node such that its offset is less or equal to the given
   */
  getNodeByOffset(offset: number): Node {
    let elementOffset: number;

    // First, find the last element in the document, such that
    // this.getElementOffset(element) <= offset; if offest matches
    // exactly, just return it.
    let element = this.root;
    while (true) {
      elementOffset = this.getElementOffset(element);
      if (elementOffset >= offset) {
        return element;
      }
      const children = element.children; // Element children
      if (!children) {
        break;
      }
      const index = Base.binarySearch(children.length, (index) => {
        const child = children[index];
        const childOffset = this.getElementOffset(child);
        return childOffset > offset;
      });
      if (index == 0) {
        break;
      }
      if (VIVLIOSTYLE_DEBUG) {
        if (index < children.length) {
          const elemOffset = this.getElementOffset(children[index]);
          if (elemOffset <= offset) {
            throw new Error("Consistency check failed!");
          }
        }
      }
      element = children[index - 1];
    }

    // Now we have element with offset less than desired. Find following
    // (non-element) node with the right offset.
    let nodeOffset = elementOffset + 1;
    let node: Node | null = element;
    let next: Node | null = node.firstChild || node.nextSibling;
    let lastGood: Node | null = null;
    while (true) {
      if (next) {
        if (next.nodeType == 1) {
          break;
        }
        node = next;
        lastGood = node;
        nodeOffset += (next.textContent as string).length;
        if (nodeOffset > offset && !/^\s*$/.test(next.textContent)) {
          break;
        }
      } else {
        node = node.parentNode;
        if (!node) {
          break;
        }
      }
      next = node.nextSibling;
    }
    if (next && lastGood && /^\s*$/.test(lastGood.textContent)) {
      // skip white-space text node
      lastGood = next;
    }
    return lastGood || element;
  }

  private buildIdMap(e: Element): void {
    const id = e.getAttribute("id");
    if (id && !this.idMap[id]) {
      this.idMap[id] = e;
    }
    const xmlid = e.getAttributeNS(Base.NS.XML, "id");
    if (xmlid && !this.idMap[xmlid]) {
      this.idMap[xmlid] = e;
    }
    for (let c = e.firstElementChild; c; c = c.nextElementSibling) {
      this.buildIdMap(c);
    }
  }

  /**
   * Get element by URL in the source document(s). URL must be in either '#id'
   * or 'url#id' form.
   */
  getElement(url: string): Element | null {
    const m = url.match(/([^#]*)#(.+)$/);
    if (!m || (m[1] && m[1] != this.url)) {
      return null;
    }
    const id = m[2];
    let r: Element = this.document.getElementById(id);
    if (!r && this.document.getElementsByName) {
      r = this.document.getElementsByName(id)[0];
    }
    if (!r) {
      if (!this.idMap) {
        this.idMap = {};
        this.buildIdMap(this.document.documentElement);
      }
      r = this.idMap[id];
    }
    return r;
  }
}

/**
 * cf. https://w3c.github.io/DOM-Parsing/#the-domparser-interface
 * @enum {string}
 */
export enum DOMParserSupportedType {
  TEXT_HTML = "text/html",
  TEXT_XML = "text/xml",
  APPLICATION_XML = "application/xml",
  APPLICATION_XHTML_XML = "application/xhtml+xml",
  IMAGE_SVG_XML = "image/svg+xml",
}

/**
 * Parses a string with a DOMParser and returns the document.
 * If a parse error occurs, return null.
 */
export function parseAndReturnNullIfError(
  str: string,
  type: string,
  opt_parser?: DOMParser,
): Document | null {
  const parser = opt_parser || new DOMParser();
  let doc: Document;
  try {
    doc = parser.parseFromString(str, type as DOMParserSupportedType);
  } catch (e) {}
  if (!doc) {
    return null;
  } else {
    const docElement = doc.documentElement;
    const errorTagName = "parsererror";
    if (docElement.localName === errorTagName) {
      return null;
    } else {
      for (let c = docElement.firstElementChild; c; c = c.nextElementSibling) {
        if (c.localName === errorTagName) {
          return null;
        }
      }
    }
  }
  return doc;
}

/**
 * @returns null if contentType cannot be inferred from HTTP header and file
 *     extension
 */
export function resolveContentType(response: Net.FetchResponse): string | null {
  const contentType = response.contentType;
  if (contentType) {
    const supportedKeys = Object.keys(DOMParserSupportedType);
    for (let i = 0; i < supportedKeys.length; i++) {
      if (DOMParserSupportedType[supportedKeys[i]] === contentType) {
        return contentType;
      }
    }
    if (contentType.match(/\+xml$/)) {
      return DOMParserSupportedType.APPLICATION_XML;
    }
  }
  const match = response.url.match(/\.([^./]+)$/);
  if (match) {
    const extension = match[1];
    switch (extension) {
      case "html":
      case "htm":
        return DOMParserSupportedType.TEXT_HTML;
      case "xhtml":
      case "xht":
        return DOMParserSupportedType.APPLICATION_XHTML_XML;
      case "svg":
      case "svgz":
        return DOMParserSupportedType.IMAGE_SVG_XML;
      case "opf":
      case "xml":
        return DOMParserSupportedType.APPLICATION_XML;
    }
  }
  return null;
}

export function parseXMLResource(
  response: Net.FetchResponse,
  store: XMLDocStore,
): Task.Result<XmlDoc.XMLDocHolder> {
  let doc = response.responseXML;
  if (!doc) {
    const parser = new DOMParser();
    const text = response.responseText;
    if (text) {
      const contentType = resolveContentType(response);
      doc = parseAndReturnNullIfError(
        text,
        contentType || DOMParserSupportedType.APPLICATION_XML,
        parser,
      );

      // When contentType cannot be inferred from HTTP header and file
      // extension, we use root element's tag name to infer the contentType. If
      // it is html or svg, we re-parse the source with an appropriate
      // contentType.
      if (doc && !contentType) {
        const root = doc.documentElement;
        if (root.localName.toLowerCase() === "html" && !root.namespaceURI) {
          doc = parseAndReturnNullIfError(
            text,
            DOMParserSupportedType.TEXT_HTML,
            parser,
          );
        } else if (
          root.localName.toLowerCase() === "svg" &&
          (doc as any).contentType !== DOMParserSupportedType.IMAGE_SVG_XML
        ) {
          doc = parseAndReturnNullIfError(
            text,
            DOMParserSupportedType.IMAGE_SVG_XML,
            parser,
          );
        }
      }
      if (!doc) {
        // Fallback to HTML parsing
        doc = parseAndReturnNullIfError(
          text,
          DOMParserSupportedType.TEXT_HTML,
          parser,
        );
      }
    }
  }
  const xmldoc = doc ? new XMLDocHolder(store, response.url, doc) : null;
  return Task.newResult(xmldoc);
}

export function newXMLDocStore(): XMLDocStore {
  return new Net.ResourceStore(
    parseXMLResource,
    Net.FetchResponseType.DOCUMENT,
  );
}

export class Predicate implements XmlDoc.Predicate {
  constructor(public readonly fn: (p1: Node) => boolean) {}

  check(node: Node): boolean {
    return this.fn(node);
  }

  withAttribute(name: string, value: string): Predicate {
    return new Predicate(
      (node) =>
        this.check(node) &&
        node.nodeType == 1 &&
        (node as Element).getAttribute(name) == value,
    );
  }

  withChild(name: string, opt_childPredicate?: Predicate): Predicate {
    return new Predicate((node) => {
      if (!this.check(node)) {
        return false;
      }
      let list = new NodeList([node]);
      list = list.child(name);
      if (opt_childPredicate) {
        list = list.predicate(opt_childPredicate);
      }
      return list.size() > 0;
    });
  }
}

export const predicate = new Predicate((node) => true);

export class NodeList implements XmlDoc.NodeList {
  constructor(public readonly nodes: Node[]) {}

  asArray(): Node[] {
    return this.nodes;
  }

  size(): number {
    return this.nodes.length;
  }

  /**
   * Filter with predicate
   */
  predicate(pr: Predicate): NodeList {
    const arr = [];
    for (const n of this.nodes) {
      if (pr.check(n)) {
        arr.push(n);
      }
    }
    return new NodeList(arr);
  }

  forEachNode(fn: (p1: Node, p2: (p1: Node) => void) => void): NodeList {
    const arr = [];
    const add = (n) => {
      arr.push(n);
    };
    for (let i = 0; i < this.nodes.length; i++) {
      fn(this.nodes[i], add);
    }
    return new NodeList(arr);
  }

  /**
   * @template T
   */
  forEach<T>(fn: (p1: Node) => T): T[] {
    const arr = [];
    for (let i = 0; i < this.nodes.length; i++) {
      arr.push(fn(this.nodes[i]));
    }
    return arr;
  }

  /**
   * @template T
   */
  forEachNonNull<T>(fn: (p1: Node) => T): T[] {
    const arr = [];
    for (let i = 0; i < this.nodes.length; i++) {
      const t = fn(this.nodes[i]);
      if (t != null) {
        arr.push(t);
      }
    }
    return arr;
  }

  child(tag: string): NodeList {
    return this.forEachNode((node, add) => {
      for (let c: Node = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType == 1 && (c as Element).localName == tag) {
          add(c);
        }
      }
    });
  }

  childElements(): NodeList {
    return this.forEachNode((node, add) => {
      for (let c: Node = node.firstChild; c; c = c.nextSibling) {
        if (c.nodeType == 1) {
          add(c);
        }
      }
    });
  }

  attribute(name: string): (string | null)[] {
    return this.forEachNonNull((node) => {
      if (node.nodeType == 1) {
        return (node as Element).getAttribute(name);
      }
      return null;
    });
  }

  textContent(): (string | null)[] {
    return this.forEach((node) => node.textContent);
  }
}

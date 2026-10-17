import initializeWasm, { GraphSimulation } from './wasm/publish_graph.js';
import wasmBytes from './wasm/publish_graph_bg.wasm';

type NodePositions = Record<string, [number, number] | null | undefined>;
type Link = [string, string];
type Message = {
  nodes?: NodePositions;
  addNodes?: NodePositions;
  links?: Link[];
  forceNode?: { id: string; x: number | null; y: number | null };
  forces?: {
    centerStrength?: number;
    linkStrength?: number;
    linkDistance?: number;
    repelStrength?: number;
  };
  alpha?: number;
  alphaTarget?: number;
  run?: boolean;
};
type Frame = { ignore?: true; shared?: SharedArrayBuffer; id?: string[]; buffer?: ArrayBufferLike; v?: number };
type WorkerPort = {
  onmessage: ((event: MessageEvent<Message>) => void) | null;
  postMessage(message: Frame, transfer?: Transferable[]): void;
};

const port = self as unknown as WorkerPort;
const alphaDecay = 1 - Math.pow(0.001, 1 / 300);
const tickInterval = 1000 / 60;
let simulation: GraphSimulation;
let nodeIds: string[] = [];
let currentLinks: Link[] = [];
let previousPositions = new Map<string, [number, number]>();
let alpha = 1;
let alphaTarget = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let sharedBuffer: SharedArrayBuffer | undefined;
let canShare = false;
let forces = { centerStrength: 0.1, linkStrength: 1, linkDistance: 250, repelStrength: 1000 };

const ready = initializeWasm({ module_or_path: wasmBytes }).then(() => {
  simulation = new GraphSimulation();
  if (typeof SharedArrayBuffer === 'undefined') return;
  try {
    sharedBuffer = new SharedArrayBuffer(1);
    canShare = true;
    port.postMessage({ ignore: true, shared: sharedBuffer });
  } catch {
    canShare = false;
  }
});

function hasOwn(value: object, property: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function keepLinksForGraph(links: Link[], ids: Set<string>) {
  return links.filter(([source, target]) => ids.has(source) && ids.has(target));
}

function setGraph(nodes: NodePositions) {
  const requestedIds = Object.keys(nodes);
  const requested = new Set(requestedIds);
  const nextIds = nodeIds.filter(id => requested.has(id));
  const present = new Set(nextIds);
  for (const id of requestedIds) {
    if (!present.has(id)) {
      nextIds.push(id);
      present.add(id);
    }
  }

  const coordinates = new Float32Array(nextIds.length * 2);
  const nextPositions = new Map<string, [number, number]>();
  for (let index = 0; index < nextIds.length; index++) {
    const id = nextIds[index];
    const supplied = nodes[id];
    const old = previousPositions.get(id) ?? [0, 0];
    const x = supplied ? supplied[0] : old[0];
    const y = supplied ? supplied[1] : old[1];
    coordinates[index * 2] = x;
    coordinates[index * 2 + 1] = y;
    nextPositions.set(id, [x, y]);
  }

  nodeIds = nextIds;
  previousPositions = nextPositions;
  currentLinks = keepLinksForGraph(currentLinks, present);
  simulation.init(nodeIds, coordinates, currentLinks);
}

function setLinks(links: Link[]) {
  const validIds = new Set(nodeIds);
  currentLinks = keepLinksForGraph(links, validIds);
  simulation.set_links(currentLinks);
}

/** Append nodes without reinitializing or replacing the existing simulation. */
function addNodes(nodes: NodePositions) {
  const additions = Object.entries(nodes).filter(([id, point]) => !nodeIds.includes(id) && point);
  if (!additions.length) return;
  const ids = additions.map(([id]) => id);
  const coordinates = new Float32Array(additions.length * 2);
  additions.forEach(([, point], index) => {
    coordinates[index * 2] = point![0];
    coordinates[index * 2 + 1] = point![1];
  });
  simulation.add_nodes(ids, coordinates);
  additions.forEach(([id, point]) => {
    nodeIds.push(id);
    previousPositions.set(id, [point![0], point![1]]);
  });
}

function postFrame() {
  const frame = simulation.complete();
  const ids = [...nodeIds];
  for (let index = 0; index < ids.length; index++) {
    previousPositions.set(ids[index], [frame[index * 2], frame[index * 2 + 1]]);
  }

  if (canShare) {
    const byteLength = frame.length * Float32Array.BYTES_PER_ELEMENT + Uint32Array.BYTES_PER_ELEMENT;
    if (!sharedBuffer || sharedBuffer.byteLength !== byteLength) {
      try {
        sharedBuffer = new SharedArrayBuffer(byteLength);
      } catch {
        canShare = false;
      }
    }
    if (canShare && sharedBuffer) {
      new Float32Array(sharedBuffer, 0, frame.length).set(frame);
      const version = new Uint32Array(sharedBuffer, byteLength - 4, 1);
      const currentVersion = version[0];
      version[0] = currentVersion + 1;
      port.postMessage({ id: ids, buffer: sharedBuffer, v: currentVersion });
      return;
    }
  }

  const buffer = frame.buffer as ArrayBuffer;
  port.postMessage({ id: ids, buffer }, [buffer]);
}

function schedule() {
  if (!timer) timer = setTimeout(tick, tickInterval);
}

function tick() {
  timer = undefined;
  if (alpha <= 0.001) return;
  schedule();
  if (nodeIds.length === 0) return;
  alpha += (alphaTarget - alpha) * alphaDecay;
  simulation.simulate(alpha);
  postFrame();
}

function applyMessage(message: Message) {
  const hasNodes = hasOwn(message, 'nodes') && message.nodes != null;
  const hasAddNodes = hasOwn(message, 'addNodes') && message.addNodes != null;
  const hasLinks = hasOwn(message, 'links') && message.links != null;
  if (hasLinks) currentLinks = message.links ?? [];
  if (hasNodes) {
    setGraph(message.nodes ?? {});
    if (hasLinks) setLinks(message.links ?? []);
  } else if (hasAddNodes) {
    addNodes(message.addNodes ?? {});
    if (hasLinks) setLinks(message.links ?? []);
  } else if (hasLinks) {
    setLinks(message.links ?? []);
  }

  if (message.forceNode) {
    simulation.set_force_node(message.forceNode.id, message.forceNode.x, message.forceNode.y);
  }
  if (message.forces) {
    forces = { ...forces, ...message.forces };
    simulation.set_forces(forces.centerStrength, forces.linkStrength, forces.linkDistance, forces.repelStrength);
  }
  if (message.alpha !== undefined && alpha < message.alpha) alpha = message.alpha;
  if (message.alphaTarget !== undefined) alphaTarget = message.alphaTarget;
  if (message.run !== undefined) schedule();
}

let messageQueue = ready;
port.onmessage = event => {
  messageQueue = messageQueue.then(() => applyMessage(event.data));
};


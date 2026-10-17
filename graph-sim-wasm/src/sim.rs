//! Rust/WASM port of the graph engine in `vendor/publish/publish.obsidian.md/sim.js`.
//!
//! The original module's `init`, `simulate`, and `complete` exports operate on
//! 20-byte node records (`x`, `y`, `vx`, `vy`, degree/index) and 12-byte link
//! records (source index, target index, source/target bias). Its `manyBody`
//! routine builds one fixed square grid, folds it into parent levels, then
//! runs `visitCharge` and `visitCollide` over that shared tree. This keeps the
//! same stages and state transitions while Rust owns its vectors instead of
//! exposing raw linear-memory offsets to TypeScript.

use std::collections::{HashMap, HashSet};

use js_sys::{Array, Float32Array};
use wasm_bindgen::prelude::*;

const MIN_CHARGE_DISTANCE: f32 = 30.0;
const CHARGE_THETA: f32 = 0.9;
const COLLISION_RADIUS: f32 = 60.0;
const COLLISION_STRENGTH: f32 = 0.5;
const VELOCITY_RETENTION: f32 = 0.6;

#[derive(Clone, Debug)]
struct Node {
    id: String,
    x: f32,
    y: f32,
    vx: f32,
    vy: f32,
    fx: Option<f32>,
    fy: Option<f32>,
    degree: u32,
}

#[derive(Clone, Copy, Debug)]
struct Link {
    source: usize,
    target: usize,
    bias: f32,
}

#[derive(Clone, Debug)]
struct ChargeCell {
    value: f32,
    x: f32,
    y: f32,
    sum_x: f32,
    sum_y: f32,
}

#[derive(Clone, Debug)]
struct QuadNode {
    kind: QuadKind,
    charge: ChargeCell,
    max_radius: f32,
}

#[derive(Clone, Debug)]
enum QuadKind {
    Leaf(Vec<usize>),
    Branch([Option<Box<QuadNode>>; 4]),
}

#[derive(Clone, Copy, Debug)]
struct Bounds {
    x0: f32,
    y0: f32,
    width: f32,
    height: f32,
    size: f32,
}

/// Owns the node/link state used by the publish graph worker.
#[wasm_bindgen]
pub struct GraphSimulation {
    nodes: Vec<Node>,
    links: Vec<Link>,
    center_strength: f32,
    link_strength: f32,
    link_distance: f32,
    repel_strength: f32,
    collision_strength: f32,
}

#[wasm_bindgen]
impl GraphSimulation {
    #[wasm_bindgen(constructor)]
    pub fn new() -> GraphSimulation {
        GraphSimulation {
            nodes: Vec::new(),
            links: Vec::new(),
            center_strength: 0.1,
            link_strength: 1.0,
            link_distance: 250.0,
            repel_strength: -1000.0,
            collision_strength: COLLISION_STRENGTH,
        }
    }

    /// Equivalent to the original `init(ptr, nodeCount, linkCount)` stage.
    /// Existing IDs retain position, velocity, and fixed coordinates. Removed
    /// IDs disappear; new IDs are appended in the supplied key order.
    pub fn init(&mut self, ids: Array, positions: Float32Array, links: Array) {
        let requested = array_strings(&ids);
        let coordinates = positions.to_vec();
        let wanted: HashSet<&str> = requested.iter().map(String::as_str).collect();
        let previous = self.nodes.drain(..).collect::<Vec<_>>();
        let mut nodes = Vec::with_capacity(requested.len());

        // The bundled worker keeps retained nodes in their prior order before
        // appending new keys; this is observable in link biases and traversal.
        for node in previous {
            if wanted.contains(node.id.as_str()) {
                nodes.push(node);
            }
        }
        let mut existing: HashSet<String> = nodes.iter().map(|node| node.id.clone()).collect();
        for (index, id) in requested.iter().enumerate() {
            if existing.insert(id.clone()) {
                nodes.push(Node {
                    id: id.clone(),
                    x: coordinates.get(index * 2).copied().unwrap_or(0.0),
                    y: coordinates.get(index * 2 + 1).copied().unwrap_or(0.0),
                    vx: 0.0,
                    vy: 0.0,
                    fx: None,
                    fy: None,
                    degree: 0,
                });
            }
        }

        // The input object carries initial coordinates for all retained nodes
        // too, and the source worker overwrites their x/y without clearing vx.
        let requested_index: HashMap<&str, usize> = requested
            .iter()
            .enumerate()
            .map(|(index, id)| (id.as_str(), index))
            .collect();
        for node in &mut nodes {
            if let Some(index) = requested_index.get(node.id.as_str()) {
                if let (Some(x), Some(y)) =
                    (coordinates.get(index * 2), coordinates.get(index * 2 + 1))
                {
                    node.x = *x;
                    node.y = *y;
                }
            }
            node.degree = 0;
        }

        self.nodes = nodes;
        self.set_links(links);
    }

    /// Appends previously unseen nodes at supplied coordinates while retaining
    /// every existing node's position, velocity, and fixed coordinates.
    /// Call `set_links` afterward when the graph's edge set has changed.
    pub fn add_nodes(&mut self, ids: Array, positions: Float32Array) {
        let mut present: HashSet<String> = self.nodes.iter().map(|node| node.id.clone()).collect();
        let coordinates = positions.to_vec();
        for (index, id) in array_strings(&ids).into_iter().enumerate() {
            if !present.insert(id.clone()) {
                continue;
            }
            self.nodes.push(Node {
                id,
                x: coordinates.get(index * 2).copied().unwrap_or(0.0),
                y: coordinates.get(index * 2 + 1).copied().unwrap_or(0.0),
                vx: 0.0,
                vy: 0.0,
                fx: None,
                fy: None,
                degree: 0,
            });
        }
    }

    /// Rebuilds the original link records, counting endpoint degree and
    /// storing `sourceDegree / (sourceDegree + targetDegree)` as the bias.
    pub fn set_links(&mut self, links: Array) {
        for node in &mut self.nodes {
            node.degree = 0;
        }
        let indexes: HashMap<String, usize> = self
            .nodes
            .iter()
            .enumerate()
            .map(|(index, node)| (node.id.clone(), index))
            .collect();
        let mut pairs = Vec::new();
        for value in links.iter() {
            let pair = Array::from(&value);
            let (Some(source), Some(target)) = (pair.get(0).as_string(), pair.get(1).as_string())
            else {
                continue;
            };
            let (Some(&source), Some(&target)) = (indexes.get(&source), indexes.get(&target))
            else {
                continue;
            };
            pairs.push((source, target));
            self.nodes[source].degree = self.nodes[source].degree.saturating_add(1);
            self.nodes[target].degree = self.nodes[target].degree.saturating_add(1);
        }
        self.links = pairs
            .into_iter()
            .map(|(source, target)| {
                let a = self.nodes[source].degree as f32;
                let b = self.nodes[target].degree as f32;
                Link {
                    source,
                    target,
                    bias: a / (a + b),
                }
            })
            .collect();
    }

    /// Reconfigures the four values accepted by the source worker's `forces`
    /// message. Sub-unit repel strengths use the source's `-1` floor.
    pub fn set_forces(
        &mut self,
        center_strength: f32,
        link_strength: f32,
        link_distance: f32,
        repel_strength: f32,
    ) {
        self.center_strength = center_strength;
        self.link_strength = link_strength;
        self.link_distance = link_distance;
        self.repel_strength = if repel_strength.abs() < 1.0 {
            -1.0
        } else {
            -repel_strength
        };
    }

    /// Exposes the final manyBody argument for parity tests and callers that
    /// need the original worker's collision tuning.
    pub fn set_collision_strength(&mut self, strength: f32) {
        self.collision_strength = strength;
    }

    /// Mirrors the worker's `forceNode` update. A null coordinate releases
    /// that axis; a number fixes it at that coordinate.
    pub fn set_force_node(&mut self, id: String, x: Option<f32>, y: Option<f32>) {
        if let Some(node) = self.nodes.iter_mut().find(|node| node.id == id) {
            node.fx = x;
            node.fy = y;
        }
    }

    /// Applies one WASM `simulate` tick: center, links, grid charge, collision.
    pub fn simulate(&mut self, alpha: f32) {
        let center_alpha = alpha * self.center_strength;
        for node in &mut self.nodes {
            node.vx -= center_alpha * node.x;
            node.vy -= center_alpha * node.y;
        }

        // The link force uses 1/min(endpoint degree); `init` supplied the
        // opposing endpoint bias stored in the original 12-byte link.
        let alpha_link = alpha * self.link_strength;
        for link in self.links.clone() {
            let source = link.source;
            let target = link.target;
            let source_degree = self.nodes[source].degree.max(1) as f32;
            let target_degree = self.nodes[target].degree.max(1) as f32;
            let mut dx = self.nodes[target].x + self.nodes[target].vx
                - self.nodes[source].x
                - self.nodes[source].vx;
            let mut dy = self.nodes[target].y + self.nodes[target].vy
                - self.nodes[source].y
                - self.nodes[source].vy;
            if dx == 0.0 {
                dx = 0.1;
            }
            if dy == 0.0 {
                dy = 0.1;
            }
            let length = (dx * dx + dy * dy).sqrt();
            let strength = alpha_link / source_degree.min(target_degree);
            let factor = ((length - self.link_distance) / length) * strength;
            dx *= factor;
            dy *= factor;

            // Keep the source order even for self-links, where both writes
            // target the same velocity record in the original WASM.
            self.nodes[target].vx -= dx * link.bias;
            self.nodes[target].vy -= dy * link.bias;
            self.nodes[source].vx += dx * (1.0 - link.bias);
            self.nodes[source].vy += dy * (1.0 - link.bias);
        }
        self.visit_charge(alpha * self.repel_strength);
        self.visit_collide();
    }

    /// Mirrors `complete(ptr, nodeCount, 0.6)` and the worker's subsequent
    /// fixed-coordinate override. Returns an interleaved `[x, y, ...]` frame.
    pub fn complete(&mut self) -> Float32Array {
        let mut output = Vec::with_capacity(self.nodes.len() * 2);
        for node in &mut self.nodes {
            node.vx *= VELOCITY_RETENTION;
            node.vy *= VELOCITY_RETENTION;
            node.x += node.vx;
            node.y += node.vy;
            if let Some(x) = node.fx {
                node.x = x;
                node.vx = 0.0;
            }
            if let Some(y) = node.fy {
                node.y = y;
                node.vy = 0.0;
            }
            output.push(node.x);
            output.push(node.y);
        }
        Float32Array::from(output.as_slice())
    }
}

impl GraphSimulation {
    /// Port of `manyBody`'s fixed-grid charge pass and `visitCharge` walk.
    fn visit_charge(&mut self, alpha_strength: f32) {
        if self.nodes.is_empty() {
            return;
        }
        // The supplied WASM's charge quadtree uses stored node x/y. The
        // collision pass below instead snapshots x+vx/y+vy before its walk.
        let points = self
            .nodes
            .iter()
            .map(|node| (node.x, node.y))
            .collect::<Vec<_>>();
        let Some((tree, bounds)) = QuadNode::build(&points) else {
            return;
        };
        let theta_squared = CHARGE_THETA * CHARGE_THETA;
        let distance_min_squared = MIN_CHARGE_DISTANCE * MIN_CHARGE_DISTANCE;
        for index in 0..self.nodes.len() {
            let point = points[index];
            let mut velocity = (self.nodes[index].vx, self.nodes[index].vy);
            visit_charge(
                &tree,
                bounds,
                &points,
                index,
                point,
                alpha_strength,
                theta_squared,
                distance_min_squared,
                &mut velocity,
            );
            self.nodes[index].vx = velocity.0;
            self.nodes[index].vy = velocity.1;
        }
    }

    /// Port of `manyBody`'s shared grid and `visitCollide` pass.
    fn visit_collide(&mut self) {
        if self.nodes.len() < 2 {
            return;
        }
        let points = self
            .nodes
            .iter()
            .map(|node| (node.x, node.y))
            .collect::<Vec<_>>();
        let Some((tree, bounds)) = QuadNode::build(&points) else {
            return;
        };
        let radii = vec![COLLISION_RADIUS; self.nodes.len()];
        for index in 0..self.nodes.len() {
            let point = (
                self.nodes[index].x + self.nodes[index].vx,
                self.nodes[index].y + self.nodes[index].vy,
            );
            let mut velocity = (self.nodes[index].vx, self.nodes[index].vy);
            visit_collide(
                &tree,
                bounds,
                &radii,
                index,
                point,
                self.collision_strength,
                &mut velocity,
                &mut self.nodes,
            );
            self.nodes[index].vx = velocity.0;
            self.nodes[index].vy = velocity.1;
        }
    }
}

fn array_strings(values: &Array) -> Vec<String> {
    (0..values.length())
        .filter_map(|index| values.get(index).as_string())
        .collect()
}

impl QuadNode {
    fn build(points: &[(f32, f32)]) -> Option<(QuadNode, Bounds)> {
        let first = *points.first()?;
        let (mut min_x, mut min_y, mut max_x, mut max_y) = (first.0, first.1, first.0, first.1);
        for &(x, y) in points.iter().skip(1) {
            min_x = min_x.min(x);
            min_y = min_y.min(y);
            max_x = max_x.max(x);
            max_y = max_y.max(y);
        }

        // The Publish WASM uses a complete square grid whose side is the
        // largest power of two with side² < node count. It buckets nodes into
        // that grid, then folds adjacent 2×2 cells into parent levels.
        let mut side = 1usize;
        while side
            .saturating_mul(2)
            .saturating_mul(side.saturating_mul(2))
            < points.len()
        {
            side *= 2;
        }
        let span_x = max_x - min_x;
        let span_y = max_y - min_y;
        let mut buckets = vec![Vec::new(); side * side];
        let cell_width = if span_x == 0.0 {
            1.0
        } else {
            span_x / side as f32
        };
        let cell_height = if span_y == 0.0 {
            1.0
        } else {
            span_y / side as f32
        };
        for (index, &(x, y)) in points.iter().enumerate() {
            let x_cell = (((x - min_x) / cell_width).floor() as usize).min(side - 1);
            let y_cell = (((y - min_y) / cell_height).floor() as usize).min(side - 1);
            // Source buckets are head-linked, so their traversal order is
            // newest first even though their aggregate sums were accumulated
            // in node order.
            buckets[x_cell * side + y_cell].insert(0, index);
        }
        let bounds = Bounds {
            x0: min_x,
            y0: min_y,
            width: span_x,
            height: span_y,
            size: span_x.max(span_y),
        };
        let depth = side.trailing_zeros() as u8;
        let mut root = QuadNode::from_grid(0, 0, 0, side, depth, bounds, &buckets);
        root.aggregate(points);
        Some((root, bounds))
    }

    fn from_grid(
        level: usize,
        x_cell: usize,
        y_cell: usize,
        side: usize,
        depth: u8,
        bounds: Bounds,
        buckets: &[Vec<usize>],
    ) -> Self {
        if level == depth as usize {
            return QuadNode {
                kind: QuadKind::Leaf(buckets[x_cell * side + y_cell].clone()),
                charge: ChargeCell {
                    value: 0.0,
                    x: 0.0,
                    y: 0.0,
                    sum_x: 0.0,
                    sum_y: 0.0,
                },
                max_radius: 0.0,
            };
        }
        let half = 1usize << (depth as usize - level - 1);
        let mut children: [Option<Box<QuadNode>>; 4] = std::array::from_fn(|_| None);
        for quadrant in 0..4 {
            let child_x = x_cell + if quadrant & 1 == 1 { half } else { 0 };
            let child_y = y_cell + if quadrant & 2 == 2 { half } else { 0 };
            children[quadrant] = Some(Box::new(QuadNode::from_grid(
                level + 1,
                child_x,
                child_y,
                side,
                depth,
                bounds.child(quadrant),
                buckets,
            )));
        }
        QuadNode {
            kind: QuadKind::Branch(children),
            charge: ChargeCell {
                value: 0.0,
                x: 0.0,
                y: 0.0,
                sum_x: 0.0,
                sum_y: 0.0,
            },
            max_radius: 0.0,
        }
    }

    fn aggregate(&mut self, points: &[(f32, f32)]) {
        let (charge, max_radius) = match &mut self.kind {
            QuadKind::Leaf(entries) => {
                let mut value = 0.0;
                let mut x = 0.0;
                let mut y = 0.0;
                for &index in entries.iter().rev() {
                    let (px, py) = points[index];
                    value += 1.0;
                    x += px;
                    y += py;
                }
                let weight = value;
                let charge = ChargeCell {
                    value,
                    x: if weight == 0.0 { 0.0 } else { x / weight },
                    y: if weight == 0.0 { 0.0 } else { y / weight },
                    sum_x: x,
                    sum_y: y,
                };
                (
                    charge,
                    if entries.is_empty() {
                        0.0
                    } else {
                        COLLISION_RADIUS
                    },
                )
            }
            QuadKind::Branch(children) => {
                let mut value = 0.0;
                let mut x = 0.0;
                let mut y = 0.0;
                let mut max_radius: f32 = 0.0;
                for child in children.iter_mut().flatten() {
                    child.aggregate(points);
                    let cell = &child.charge;
                    value += cell.value;
                    x += cell.sum_x;
                    y += cell.sum_y;
                    max_radius = max_radius.max(child.max_radius);
                }
                let charge = ChargeCell {
                    value,
                    x: if value == 0.0 { 0.0 } else { x / value },
                    y: if value == 0.0 { 0.0 } else { y / value },
                    sum_x: x,
                    sum_y: y,
                };
                (charge, max_radius)
            }
        };
        self.charge = charge;
        self.max_radius = max_radius;
    }

    fn visit<F>(&self, bounds: Bounds, callback: &mut F)
    where
        F: FnMut(&QuadNode, Bounds) -> bool,
    {
        if callback(self, bounds) {
            return;
        }
        if let QuadKind::Branch(children) = &self.kind {
            for quadrant in 0..4 {
                if let Some(child) = &children[quadrant] {
                    child.visit(bounds.child(quadrant), callback);
                }
            }
        }
    }
}

impl Bounds {
    fn child(self, quadrant: usize) -> Bounds {
        let half = self.size / 2.0;
        Bounds {
            x0: self.x0
                + if quadrant & 1 == 1 {
                    self.width / 2.0
                } else {
                    0.0
                },
            y0: self.y0
                + if quadrant & 2 == 2 {
                    self.height / 2.0
                } else {
                    0.0
                },
            width: self.width / 2.0,
            height: self.height / 2.0,
            size: half,
        }
    }
}

fn visit_charge(
    root: &QuadNode,
    bounds: Bounds,
    points: &[(f32, f32)],
    index: usize,
    point: (f32, f32),
    alpha_strength: f32,
    theta_squared: f32,
    distance_min_squared: f32,
    velocity: &mut (f32, f32),
) {
    root.visit(bounds, &mut |quad, cell_bounds| {
        let cell = &quad.charge;
        if cell.value == 0.0 {
            return true;
        }
        let mut dx = cell.x - point.0;
        let mut dy = cell.y - point.1;
        let width = cell_bounds.size;
        let mut distance_squared = dx * dx + dy * dy;
        if width * width / theta_squared < distance_squared {
            if dx == 0.0 {
                dx = 0.5;
                distance_squared += dx * dx;
            }
            if dy == 0.0 {
                dy = 0.5;
                distance_squared += dy * dy;
            }
            if distance_squared < distance_min_squared {
                distance_squared = (distance_min_squared * distance_squared).sqrt();
            }
            let strength = cell.value * alpha_strength / distance_squared;
            velocity.0 += dx * strength;
            velocity.1 += dy * strength;
            return true;
        }

        if let QuadKind::Leaf(entries) = &quad.kind {
            for &other in entries {
                if other == index {
                    continue;
                }
                let dx = points[other].0 - point.0;
                let dy = points[other].1 - point.1;
                let mut distance_squared = dx * dx + dy * dy;
                if distance_squared == 0.0 {
                    continue;
                }
                if distance_squared < distance_min_squared {
                    distance_squared = (distance_min_squared * distance_squared).sqrt();
                }
                let strength = alpha_strength / distance_squared;
                velocity.0 += dx * strength;
                velocity.1 += dy * strength;
            }
            return true;
        }

        false
    });
}

#[allow(clippy::too_many_arguments)]
fn visit_collide(
    root: &QuadNode,
    bounds: Bounds,
    radii: &[f32],
    index: usize,
    point: (f32, f32),
    strength: f32,
    velocity: &mut (f32, f32),
    nodes: &mut [Node],
) {
    root.visit(bounds, &mut |quad, cell_bounds| {
        let range = radii[index] + quad.max_radius;
        if cell_bounds.x0 > point.0 + range
            || cell_bounds.x0 + cell_bounds.width < point.0 - range
            || cell_bounds.y0 > point.1 + range
            || cell_bounds.y0 + cell_bounds.height < point.1 - range
        {
            return true;
        }
        let QuadKind::Leaf(entries) = &quad.kind else {
            return false;
        };
        for &other in entries {
            if other <= index {
                continue;
            }
            // The source cell list is built from stored positions, while its
            // collision callback reads each neighbor's live velocity.
            let mut dx = point.0 - (nodes[other].x + nodes[other].vx);
            let mut dy = point.1 - (nodes[other].y + nodes[other].vy);
            let radius = radii[index] + radii[other];
            let distance_squared = dx * dx + dy * dy;
            if distance_squared >= radius * radius {
                continue;
            }
            if distance_squared == 0.0 {
                continue;
            }
            let distance = distance_squared.sqrt();
            let overlap = (radius - distance) / distance * strength;
            dx *= overlap;
            dy *= overlap;
            let radius_a_squared = radii[index] * radii[index];
            let radius_b_squared = radii[other] * radii[other];
            let share = radius_b_squared / (radius_a_squared + radius_b_squared);
            velocity.0 += dx * share;
            velocity.1 += dy * share;
            nodes[other].vx -= dx * (1.0 - share);
            nodes[other].vy -= dy * (1.0 - share);
        }
        false
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(id: &str, x: f32, y: f32) -> Node {
        Node {
            id: id.into(),
            x,
            y,
            vx: 0.0,
            vy: 0.0,
            fx: None,
            fy: None,
            degree: 0,
        }
    }

    #[test]
    fn init_computes_the_source_link_bias_from_endpoint_degrees() {
        let mut nodes = vec![
            node("a", 0.0, 0.0),
            node("b", 100.0, 0.0),
            node("c", 200.0, 0.0),
        ];
        let links = init_links(&mut nodes, &[(0, 1), (0, 2)]);
        assert_eq!(
            nodes.iter().map(|node| node.degree).collect::<Vec<_>>(),
            [2, 1, 1]
        );
        assert_eq!(links[0].bias, 2.0 / 3.0);
        assert_eq!(links[1].bias, 2.0 / 3.0);
    }

    #[test]
    fn complete_retains_sixty_percent_of_velocity_then_applies_pins() {
        let mut nodes = vec![node("a", 10.0, -4.0)];
        nodes[0].vx = 5.0;
        nodes[0].vy = -10.0;
        nodes[0].fx = Some(42.0);
        complete(&mut nodes);
        assert_eq!((nodes[0].x, nodes[0].y), (42.0, -10.0));
        assert_eq!((nodes[0].vx, nodes[0].vy), (0.0, -6.0));
    }

    #[test]
    fn many_body_charge_repels_nodes_and_collision_keeps_them_apart() {
        let mut nodes = vec![node("a", -5.0, 0.0), node("b", 5.0, 0.0)];
        charge_nodes(&mut nodes, -200.0);
        assert!(nodes[0].vx < 0.0 && nodes[1].vx > 0.0);
        let before = (nodes[1].x + nodes[1].vx) - (nodes[0].x + nodes[0].vx);
        collide_nodes(&mut nodes);
        let after = (nodes[1].x + nodes[1].vx) - (nodes[0].x + nodes[0].vx);
        assert!(after > before);
    }

    fn init_links(nodes: &mut [Node], pairs: &[(usize, usize)]) -> Vec<Link> {
        for node in nodes.iter_mut() {
            node.degree = 0;
        }
        for &(source, target) in pairs {
            nodes[source].degree += 1;
            nodes[target].degree += 1;
        }
        pairs
            .iter()
            .map(|&(source, target)| Link {
                source,
                target,
                bias: nodes[source].degree as f32
                    / (nodes[source].degree + nodes[target].degree) as f32,
            })
            .collect()
    }

    fn complete(nodes: &mut [Node]) {
        for node in nodes {
            node.vx *= VELOCITY_RETENTION;
            node.vy *= VELOCITY_RETENTION;
            node.x += node.vx;
            node.y += node.vy;
            if let Some(x) = node.fx {
                node.x = x;
                node.vx = 0.0;
            }
            if let Some(y) = node.fy {
                node.y = y;
                node.vy = 0.0;
            }
        }
    }

    fn charge_nodes(nodes: &mut [Node], alpha_strength: f32) {
        let points = nodes
            .iter()
            .map(|node| (node.x, node.y))
            .collect::<Vec<_>>();
        let (tree, bounds) = QuadNode::build(&points).unwrap();
        for index in 0..nodes.len() {
            let mut velocity = (nodes[index].vx, nodes[index].vy);
            super::visit_charge(
                &tree,
                bounds,
                &points,
                index,
                points[index],
                alpha_strength,
                CHARGE_THETA * CHARGE_THETA,
                MIN_CHARGE_DISTANCE * MIN_CHARGE_DISTANCE,
                &mut velocity,
            );
            nodes[index].vx = velocity.0;
            nodes[index].vy = velocity.1;
        }
    }

    fn collide_nodes(nodes: &mut [Node]) {
        let points = nodes
            .iter()
            .map(|node| (node.x, node.y))
            .collect::<Vec<_>>();
        let (tree, bounds) = QuadNode::build(&points).unwrap();
        let radii = vec![COLLISION_RADIUS; nodes.len()];
        for index in 0..nodes.len() {
            let mut velocity = (nodes[index].vx, nodes[index].vy);
            super::visit_collide(
                &tree,
                bounds,
                &radii,
                index,
                points[index],
                COLLISION_STRENGTH,
                &mut velocity,
                nodes,
            );
            nodes[index].vx = velocity.0;
            nodes[index].vy = velocity.1;
        }
    }
}

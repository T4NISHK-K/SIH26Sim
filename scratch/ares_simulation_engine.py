"""
ARES Multi-Robot Simulation Engine & V2 Dataset Generator
Author: ARES Edge-AI Team
Date: 2026

Features:
- Continuous 2D kinematics (no teleportation) at delta_t = 0.5s
- Simultaneous multi-robot execution across 10 diverse scenario archetypes
- True Dynamic Interaction Radius (DIR) with local spatial fleet filtering
- Vector Relative TTC and Closest Point of Approach (CPA) calculations
- Multi-objective counterfactual action evaluation (Safety >> Traffic Flow >> Efficiency)
- Clean, non-leaked feature extraction
"""

import math
import random
import numpy as np
import pandas as pd
from typing import Dict, List, Tuple, Optional

# ==============================================================================
# CONFIGURATION & CONSTANTS
# ==============================================================================
MAP_WIDTH = 100.0   # Warehouse X dimension (meters)
MAP_HEIGHT = 100.0  # Warehouse Y dimension (meters)
DT = 0.5            # Simulation timestep (seconds)

ROBOT_RADIUS = 0.5       # Collision radius of robot (m)
CRITICAL_DISTANCE = 1.0  # Hard critical collision distance (m)
SAFE_DISTANCE = 2.0      # Safety buffer threshold (m)

V_MAX = 2.0         # Maximum operational linear speed (m/s)
V_SLOW = 0.6        # Speed when SLOW is executed (m/s)
ACCEL_MAX = 0.8     # Maximum linear acceleration (m/s^2)
DECEL_MAX = 1.5     # Maximum braking deceleration (m/s^2)

# Dynamic Interaction Radius (DIR) Parameters
R_MIN = 5.0         # Minimum perception/coordination radius (m)
R_MAX = 20.0        # Maximum perception/coordination radius (m)
TAU_REACT = 1.5     # Reaction time parameter (s)
BETA_DENSITY = 1.0  # Local fleet density scaling factor (m/neighbor)
DENSITY_RADIUS = 8.0 # Neighborhood radius for density estimation (m)

TASK_TYPES = ["PICK", "DROP", "CHARGE", "RELOCATE"]
TASK_PRIORITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
TRAFFIC_LEVELS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]

SCENARIO_TYPES = [
    "NORMAL",
    "SAME_DIRECTION",
    "FOLLOWING",
    "HEAD_ON",
    "INTERSECTION",
    "CONGESTION",
    "BLOCKED_PATH",
    "DEADLOCK",
    "LOW_BATTERY",
    "MIXED_TRAFFIC"
]

CANDIDATE_ACTIONS = ["MOVE", "SLOW", "WAIT", "REROUTE"]

# Utility Weights for Counterfactual Action Scoring (Safety >> Traffic >> Efficiency)
W_SAFETY = 100.0
W_TRAFFIC = 10.0
W_EFFICIENCY = 2.0


# ==============================================================================
# VECTOR GEOMETRY & KINEMATICS UTILITIES
# ==============================================================================

def normalize_angle(angle: float) -> float:
    """Normalize angle to [-pi, pi]."""
    while angle > math.pi:
        angle -= 2.0 * math.pi
    while angle < -math.pi:
        angle += 2.0 * math.pi
    return angle


def compute_vector_ttc_and_cpa(
    p_i: np.ndarray, v_i: np.ndarray,
    p_j: np.ndarray, v_j: np.ndarray,
    max_horizon: float = 8.0
) -> Tuple[float, float, float, float]:
    """
    Computes true vector relative motion metrics between Robot i and Robot j.
    Returns:
      (closing_velocity, true_ttc, cpa_time, cpa_distance)
    """
    r_ij = p_j - p_i          # Vector pointing from i to j
    dist = float(np.linalg.norm(r_ij))
    
    if dist < 1e-6:
        return 0.0, 0.0, 0.0, 0.0

    v_rel = v_j - v_i         # Relative velocity of j w.r.t i
    closing_vel = -float(np.dot(r_ij, v_rel)) / dist

    # Vector TTC: only defined when robots are closing in on each other
    if closing_vel > 0.05:
        true_ttc = dist / closing_vel
    else:
        true_ttc = 99.0  # Safe / diverging state

    v_rel_sq = float(np.dot(v_rel, v_rel))
    if v_rel_sq > 0.0025:
        t_cpa_raw = -float(np.dot(r_ij, v_rel)) / v_rel_sq
        t_cpa = float(np.clip(t_cpa_raw, 0.0, max_horizon))
        pos_cpa = r_ij + v_rel * t_cpa
        d_cpa = float(np.linalg.norm(pos_cpa))
    else:
        t_cpa = 0.0
        d_cpa = dist

    return closing_vel, min(true_ttc, 99.0), t_cpa, d_cpa


def compute_dynamic_interaction_radius(
    speed: float, local_density_count: int,
    r_min: float = R_MIN, r_max: float = R_MAX,
    tau: float = TAU_REACT, beta: float = BETA_DENSITY
) -> float:
    """
    One consistent Dynamic Interaction Radius (DIR) formula:
    R_i(t) = clip(R_min + speed * tau + beta * local_density, R_min, R_max)
    """
    raw_radius = r_min + max(speed, 0.0) * tau + beta * max(local_density_count, 0)
    return float(np.clip(raw_radius, r_min, r_max))


# ==============================================================================
# ROBOT AGENT CLASS
# ==============================================================================

class RobotAgent:
    def __init__(
        self,
        robot_id: str,
        x: float,
        y: float,
        target_x: float,
        target_y: float,
        velocity: float = 1.0,
        task_type: str = "PICK",
        task_priority: str = "MEDIUM",
        battery_pct: float = 85.0,
        has_alternative_route: bool = True
    ):
        self.robot_id = robot_id
        self.x = float(x)
        self.y = float(y)
        self.target_x = float(target_x)
        self.target_y = float(target_y)
        self.velocity = float(velocity)
        self.task_type = task_type
        self.task_priority = task_priority
        self.battery_pct = float(battery_pct)
        self.has_alternative_route = has_alternative_route

        # Orientation towards target
        dx = self.target_x - self.x
        dy = self.target_y - self.y
        self.heading = math.atan2(dy, dx)
        
        self.path_blocked = False
        self.obstacle_detected = False
        self.status = "ACTIVE"
        self.current_action = "MOVE"
        self.total_travel_distance = 0.0
        self.total_wait_time = 0.0
        self.completed = False

    @property
    def pos(self) -> np.ndarray:
        return np.array([self.x, self.y], dtype=float)

    @property
    def vel_vector(self) -> np.ndarray:
        return np.array([
            self.velocity * math.cos(self.heading),
            self.velocity * math.sin(self.heading)
        ], dtype=float)

    def dist_to_destination(self) -> float:
        return float(math.hypot(self.target_x - self.x, self.target_y - self.y))

    def eta(self) -> float:
        d = self.dist_to_destination()
        eff_v = max(self.velocity, 0.2)
        return d / eff_v

    def step(self, action: str):
        """Advance physical state by DT under the commanded action."""
        self.current_action = action

        if action == "WAIT":
            # Apply deceleration to 0
            self.velocity = max(0.0, self.velocity - DECEL_MAX * DT)
            self.total_wait_time += DT
        elif action == "SLOW":
            if self.velocity > V_SLOW:
                self.velocity = max(V_SLOW, self.velocity - DECEL_MAX * DT)
            else:
                self.velocity = min(V_SLOW, self.velocity + ACCEL_MAX * DT)
        elif action == "MOVE":
            self.velocity = min(V_MAX, self.velocity + ACCEL_MAX * DT)
        elif action == "REROUTE":
            # Maneuver speed, slight lateral yaw adjustment
            self.velocity = min(1.2, max(V_SLOW, self.velocity))
            self.heading = normalize_angle(self.heading + 0.15)

        # Update position
        dx = self.velocity * math.cos(self.heading) * DT
        dy = self.velocity * math.sin(self.heading) * DT
        self.x = float(np.clip(self.x + dx, 0.0, MAP_WIDTH))
        self.y = float(np.clip(self.y + dy, 0.0, MAP_HEIGHT))
        self.total_travel_distance += math.hypot(dx, dy)

        # Adjust heading smoothly towards target if not rerouting
        if action != "REROUTE":
            tg_dx = self.target_x - self.x
            tg_dy = self.target_y - self.y
            if math.hypot(tg_dx, tg_dy) > 0.5:
                desired_heading = math.atan2(tg_dy, tg_dx)
                diff = normalize_angle(desired_heading - self.heading)
                max_turn = 0.5 * DT  # max yaw rate
                self.heading = normalize_angle(self.heading + float(np.clip(diff, -max_turn, max_turn)))

        # Deplete small battery
        self.battery_pct = max(0.0, self.battery_pct - (0.01 + 0.02 * (self.velocity / V_MAX)) * DT)

        if self.dist_to_destination() <= 1.0:
            self.completed = True
            self.status = "COMPLETED"


# ==============================================================================
# COUNTERFACTUAL ACTION EVALUATOR (SAFETY >> TRAFFIC >> EFFICIENCY)
# ==============================================================================

def evaluate_counterfactual_actions(
    robot: RobotAgent,
    neighbors: List[RobotAgent],
    has_blocked_path: bool,
    has_alt_route: bool
) -> Tuple[str, Dict[str, float]]:
    """
    Evaluates 4 candidate actions [MOVE, SLOW, WAIT, REROUTE] using short lookahead.
    Optimizes multi-objective utility:
      Cost = w_safety * C_safety + w_traffic * C_traffic + w_efficiency * C_efficiency
    Safety is strictly dominant: unsafe actions receive massive penalties.
    """
    action_costs = {}

    for action in CANDIDATE_ACTIONS:
        # 1. Kinematic projection of candidate action over 3-second horizon
        if action == "WAIT":
            cand_speed = 0.0
        elif action == "SLOW":
            cand_speed = V_SLOW
        elif action == "REROUTE":
            cand_speed = min(robot.velocity, 1.2)
        else: # MOVE
            cand_speed = min(robot.velocity + ACCEL_MAX * DT, V_MAX)

        cand_vel = np.array([
            cand_speed * math.cos(robot.heading),
            cand_speed * math.sin(robot.heading)
        ], dtype=float)

        # Evaluate safety against each spatial neighbor
        min_sep = float("inf")
        min_ttc = float("inf")
        min_cpa_dist = float("inf")
        collision_imminent = False

        for other in neighbors:
            c_vel, ttc, t_cpa, d_cpa = compute_vector_ttc_and_cpa(
                robot.pos, cand_vel,
                other.pos, other.vel_vector
            )
            dist_now = float(np.linalg.norm(other.pos - robot.pos))
            min_sep = min(min_sep, dist_now)
            min_ttc = min(min_ttc, ttc)
            min_cpa_dist = min(min_cpa_dist, d_cpa)

            if d_cpa < CRITICAL_DISTANCE and ttc < 2.5:
                collision_imminent = True

        # Safety Cost Calculation
        c_safety = 0.0
        if collision_imminent:
            c_safety += 200.0  # Massive safety penalty
        if min_cpa_dist < CRITICAL_DISTANCE:
            c_safety += 150.0 * (CRITICAL_DISTANCE - min_cpa_dist)
        elif min_cpa_dist < SAFE_DISTANCE:
            c_safety += 40.0 * (SAFE_DISTANCE - min_cpa_dist)
        if min_ttc < 2.0:
            c_safety += 60.0 * (2.0 - min_ttc)

        # Traffic Flow Cost Calculation
        c_traffic = 0.0
        if action == "WAIT":
            if min_cpa_dist >= SAFE_DISTANCE and min_ttc >= 5.0 and not has_blocked_path:
                c_traffic += 30.0  # Unnecessary stopping penalty
            else:
                c_traffic += 2.0   # Justified pause
        elif action == "SLOW":
            if min_cpa_dist >= SAFE_DISTANCE + 2.0 and not has_blocked_path:
                c_traffic += 15.0  # Unnecessary slowdown penalty
        elif action == "REROUTE":
            if not has_blocked_path and min_cpa_dist >= SAFE_DISTANCE:
                c_traffic += 25.0  # Spurious rerouting penalty
            elif not has_alt_route:
                c_traffic += 100.0 # Cannot reroute without alternative route

        # Efficiency Cost Calculation
        dist_dest = robot.dist_to_destination()
        eta_sec = dist_dest / max(cand_speed, 0.1)
        
        if action == "MOVE":
            eff_penalty = 0.0
        elif action == "SLOW":
            eff_penalty = 5.0
        elif action == "WAIT":
            eff_penalty = 15.0
        else: # REROUTE
            eff_penalty = 12.0

        c_efficiency = (eta_sec * 0.1) + eff_penalty

        # If nominal path is blocked
        if has_blocked_path:
            if action == "MOVE":
                c_safety += 300.0  # Moving into blocked path is strictly unsafe
            elif action == "REROUTE" and has_alt_route:
                c_traffic -= 20.0  # Highly favorable to reroute around blockage
            elif action == "WAIT":
                c_traffic += 5.0   # Acceptable to wait if no alternate route

        # Total Utility Cost
        total_cost = (
            W_SAFETY * c_safety +
            W_TRAFFIC * c_traffic +
            W_EFFICIENCY * c_efficiency
        )
        action_costs[action] = float(total_cost)

    best_action = min(action_costs.keys(), key=lambda a: action_costs[a])
    return best_action, action_costs


# ==============================================================================
# SCENARIO GENERATOR
# ==============================================================================

def generate_scenario_fleet(
    scenario_type: str,
    episode_id: int
) -> List[RobotAgent]:
    """Instantiates simultaneous robots configured specifically for the scenario archetype."""
    robots = []
    r_id_counter = 1

    def make_id():
        nonlocal r_id_counter
        rid = f"R{r_id_counter}"
        r_id_counter += 1
        return rid

    if scenario_type == "NORMAL":
        num_robots = random.randint(4, 7)
        for _ in range(num_robots):
            sx = random.uniform(10.0, 90.0)
            sy = random.uniform(10.0, 90.0)
            gx = random.uniform(10.0, 90.0)
            gy = random.uniform(10.0, 90.0)
            robots.append(RobotAgent(
                make_id(), sx, sy, gx, gy,
                velocity=random.uniform(1.0, 1.8),
                task_type=random.choice(TASK_TYPES),
                task_priority=random.choice(TASK_PRIORITIES),
                battery_pct=random.uniform(40.0, 95.0),
                has_alternative_route=True
            ))

    elif scenario_type == "HEAD_ON":
        # Two robots driving directly towards each other along y = 50.0
        y_corridor = random.uniform(30.0, 70.0)
        r1 = RobotAgent(make_id(), 20.0, y_corridor, 80.0, y_corridor, velocity=1.5, task_priority="HIGH")
        r2 = RobotAgent(make_id(), 80.0, y_corridor, 20.0, y_corridor, velocity=1.4, task_priority="MEDIUM")
        robots.extend([r1, r2])
        # Add 1-2 background robots
        for _ in range(random.randint(1, 2)):
            robots.append(RobotAgent(make_id(), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), velocity=1.0))

    elif scenario_type == "INTERSECTION":
        # 4-way crossing converging near (50, 50)
        cx, cy = 50.0, 50.0
        r_east = RobotAgent(make_id(), cx - 25.0, cy, cx + 25.0, cy, velocity=1.6, task_priority="HIGH")
        r_north = RobotAgent(make_id(), cx, cy - 25.0, cx, cy + 25.0, velocity=1.5, task_priority="MEDIUM")
        r_west = RobotAgent(make_id(), cx + 25.0, cy, cx - 25.0, cy, velocity=1.4, task_priority="LOW")
        r_south = RobotAgent(make_id(), cx, cy + 25.0, cx, cy - 25.0, velocity=1.5, task_priority="HIGH")
        robots.extend([r_east, r_north, r_west, r_south])

    elif scenario_type == "FOLLOWING":
        # Leader and follower in narrow corridor
        y_track = random.uniform(30.0, 70.0)
        leader = RobotAgent(make_id(), 40.0, y_track, 90.0, y_track, velocity=1.0, task_priority="LOW")
        follower = RobotAgent(make_id(), 32.0, y_track, 90.0, y_track, velocity=1.8, task_priority="HIGH")
        robots.extend([leader, follower])
        for _ in range(random.randint(1, 2)):
            robots.append(RobotAgent(make_id(), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), velocity=1.2))

    elif scenario_type == "SAME_DIRECTION":
        # Multiple robots traveling in the same general corridor with velocity deltas
        y_base = random.uniform(30.0, 60.0)
        r1 = RobotAgent(make_id(), 15.0, y_base, 85.0, y_base + 3.0, velocity=1.2, task_priority="LOW")
        r2 = RobotAgent(make_id(), 20.0, y_base + 2.0, 90.0, y_base + 2.0, velocity=1.8, task_priority="HIGH")
        r3 = RobotAgent(make_id(), 10.0, y_base - 2.0, 80.0, y_base - 1.0, velocity=1.5, task_priority="MEDIUM")
        robots.extend([r1, r2, r3])

    elif scenario_type == "CONGESTION":
        # Cluster of 5-8 robots navigating into a dense central zone
        for _ in range(random.randint(5, 8)):
            ang = random.uniform(0, 2 * math.pi)
            rad = random.uniform(15.0, 30.0)
            sx = 50.0 + rad * math.cos(ang)
            sy = 50.0 + rad * math.sin(ang)
            gx = 50.0 - rad * math.cos(ang)
            gy = 50.0 - rad * math.sin(ang)
            robots.append(RobotAgent(make_id(), sx, sy, gx, gy, velocity=random.uniform(1.0, 1.7), task_priority=random.choice(TASK_PRIORITIES)))

    elif scenario_type == "BLOCKED_PATH":
        # Robot heading straight into an obstacle obstruction
        r_blocked = RobotAgent(make_id(), 25.0, 50.0, 75.0, 50.0, velocity=1.6, task_priority="HIGH", has_alternative_route=True)
        r_blocked.path_blocked = True
        r_blocked.obstacle_detected = True
        robots.append(r_blocked)
        for _ in range(random.randint(2, 4)):
            robots.append(RobotAgent(make_id(), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), velocity=1.3))

    elif scenario_type == "DEADLOCK":
        # T-junction circular wait-for deadlock
        r1 = RobotAgent(make_id(), 46.0, 50.0, 54.0, 50.0, velocity=0.8, task_priority="MEDIUM")
        r2 = RobotAgent(make_id(), 50.0, 46.0, 50.0, 54.0, velocity=0.8, task_priority="MEDIUM")
        r3 = RobotAgent(make_id(), 53.0, 50.0, 47.0, 50.0, velocity=0.8, task_priority="MEDIUM")
        robots.extend([r1, r2, r3])

    elif scenario_type == "LOW_BATTERY":
        r_crit = RobotAgent(make_id(), random.uniform(30, 70), random.uniform(30, 70), 90.0, 90.0, velocity=1.2, task_type="CHARGE", task_priority="CRITICAL", battery_pct=random.uniform(5.0, 14.0))
        robots.append(r_crit)
        for _ in range(random.randint(3, 5)):
            robots.append(RobotAgent(make_id(), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), random.uniform(10, 90), velocity=1.4))

    elif scenario_type == "MIXED_TRAFFIC":
        r_vip = RobotAgent(make_id(), 15.0, 50.0, 85.0, 50.0, velocity=1.8, task_type="PICK", task_priority="CRITICAL")
        r_low1 = RobotAgent(make_id(), 45.0, 52.0, 75.0, 52.0, velocity=1.0, task_type="RELOCATE", task_priority="LOW")
        r_low2 = RobotAgent(make_id(), 55.0, 48.0, 20.0, 48.0, velocity=1.1, task_type="RELOCATE", task_priority="LOW")
        robots.extend([r_vip, r_low1, r_low2])

    return robots


# ==============================================================================
# EPISODE SIMULATION & DATA EXTRACTION ENGINE
# ==============================================================================

def run_simulation_episode(
    episode_id: int,
    scenario_type: str,
    max_steps: int = 30
) -> List[Dict]:
    """
    Executes an independent multi-agent simulation episode.
    All robots exist simultaneously at every timestamp.
    Extracts features and optimal counterfactual action label at each step.
    """
    fleet = generate_scenario_fleet(scenario_type, episode_id)
    episode_records = []

    for step_idx in range(max_steps):
        t_sec = round(step_idx * DT, 2)
        active_robots = [r for r in fleet if r.status == "ACTIVE"]

        if len(active_robots) == 0:
            break

        # 1. Measure local fleet density and DIR for each robot
        step_spatial_data = {}
        for r in active_robots:
            # Count robots in density radius
            density_count = sum(
                1 for other in active_robots
                if other.robot_id != r.robot_id and float(np.linalg.norm(other.pos - r.pos)) <= DENSITY_RADIUS
            )
            dir_radius = compute_dynamic_interaction_radius(r.velocity, density_count)
            
            # Spatial filter: only neighbors strictly within DIR
            neighbors_in_dir = [
                other for other in active_robots
                if other.robot_id != r.robot_id and float(np.linalg.norm(other.pos - r.pos)) <= dir_radius
            ]
            step_spatial_data[r.robot_id] = {
                "dir_radius": dir_radius,
                "neighbors": neighbors_in_dir
            }

        # 2. For each robot, calculate clean physics features and counterfactual action
        commands_this_step = {}
        for r in active_robots:
            neighbors = step_spatial_data[r.robot_id]["neighbors"]
            dir_radius = step_spatial_data[r.robot_id]["dir_radius"]

            # Compute relative geometry with nearest neighbor in DIR
            if len(neighbors) > 0:
                # Find nearest neighbor
                nearest_n = min(neighbors, key=lambda other: float(np.linalg.norm(other.pos - r.pos)))
                dist_nearest = float(np.linalg.norm(nearest_n.pos - r.pos))
                c_vel, ttc, t_cpa, d_cpa = compute_vector_ttc_and_cpa(
                    r.pos, r.vel_vector,
                    nearest_n.pos, nearest_n.vel_vector
                )
                rel_speed = float(np.linalg.norm(nearest_n.vel_vector - r.vel_vector))
                rel_heading = normalize_angle(nearest_n.heading - r.heading)

                # Heading category
                abs_rel_h = abs(rel_heading)
                if abs_rel_h <= math.pi / 4.0:
                    rel_dir = "SAME"
                elif abs_rel_h >= 3.0 * math.pi / 4.0:
                    rel_dir = "OPPOSITE"
                else:
                    rel_dir = "CROSSING"

                # Check geometric path intersection
                inter_conflict = int(rel_dir == "CROSSING" and d_cpa < SAFE_DISTANCE and ttc < 4.0)
            else:
                dist_nearest = 99.0
                c_vel = 0.0
                ttc = 99.0
                t_cpa = 0.0
                d_cpa = 99.0
                rel_speed = 0.0
                rel_heading = 0.0
                rel_dir = "NONE"
                inter_conflict = 0

            # Traffic level derived from local neighbor count
            n_count = len(neighbors)
            if n_count == 0:
                traffic_lvl = "LOW"
            elif n_count <= 2:
                traffic_lvl = "MEDIUM"
            elif n_count <= 4:
                traffic_lvl = "HIGH"
            else:
                traffic_lvl = "CRITICAL"

            # Counterfactual action evaluation
            best_action, action_costs = evaluate_counterfactual_actions(
                r, neighbors, r.path_blocked, r.has_alternative_route
            )
            commands_this_step[r.robot_id] = best_action

            # Clean record WITHOUT ANY LEAKAGE
            episode_records.append({
                # Metadata (for splitting & tracking; NOT all are training features)
                "episode_id": int(episode_id),
                "timestamp_sec": float(t_sec),
                "robot_id": str(r.robot_id),
                "scenario": str(scenario_type),

                # Pure Kinematic & Spatial State (Features)
                "current_x": float(round(r.x, 3)),
                "current_y": float(round(r.y, 3)),
                "destination_x": float(round(r.target_x, 3)),
                "destination_y": float(round(r.target_y, 3)),
                "distance_to_destination_m": float(round(r.dist_to_destination(), 3)),
                "eta_sec": float(round(r.eta(), 3)),
                "speed_mps": float(round(r.velocity, 3)),
                "heading_rad": float(round(r.heading, 3)),
                "battery_pct": float(round(r.battery_pct, 2)),

                # Contextual & Operational Flags (Features)
                "task_type": str(r.task_type),
                "task_priority": str(r.task_priority),
                "traffic_level": str(traffic_lvl),
                "obstacle_detected": int(r.obstacle_detected),
                "path_blocked": int(r.path_blocked),
                "alternative_route_available": int(r.has_alternative_route),

                # Dynamic Interaction Radius & Spatial Neighbor Metrics (Features)
                "dynamic_interaction_radius_m": float(round(dir_radius, 2)),
                "nearby_robot_count": int(n_count),
                "nearest_robot_distance_m": float(round(dist_nearest, 3)),
                "nearest_robot_relative_speed_mps": float(round(rel_speed, 3)),
                "nearest_robot_relative_heading_rad": float(round(rel_heading, 3)),
                "relative_direction": str(rel_dir),

                # True Vector Physics Features (Features)
                "closing_velocity_mps": float(round(c_vel, 3)),
                "true_ttc_sec": float(round(ttc, 2)),
                "cpa_time_sec": float(round(t_cpa, 2)),
                "cpa_distance_m": float(round(d_cpa, 3)),
                "intersection_conflict": int(inter_conflict),

                # Target Ground Truth Label
                "decision": str(best_action)
            })

        # 3. Advance all robots continuously under chosen actions
        for r in active_robots:
            cmd = commands_this_step[r.robot_id]
            r.step(cmd)

    return episode_records


# ==============================================================================
# DATASET GENERATION PIPELINE
# ==============================================================================

def generate_ares_v2_dataset(
    num_episodes: int = 180,
    steps_per_episode: int = 28,
    seed: int = 42
) -> pd.DataFrame:
    """Generates the full ARES V2 dataset across all 10 scenario archetypes."""
    random.seed(seed)
    np.random.seed(seed)

    all_records = []
    print(f"Starting ARES V2 simulation across {num_episodes} episodes...")

    for ep_id in range(1, num_episodes + 1):
        # Evenly cycle through all 10 scenario archetypes
        scen = SCENARIO_TYPES[(ep_id - 1) % len(SCENARIO_TYPES)]
        ep_data = run_simulation_episode(ep_id, scen, max_steps=steps_per_episode)
        all_records.extend(ep_data)

        if ep_id % 30 == 0 or ep_id == num_episodes:
            print(f"  [Progress] Episode {ep_id}/{num_episodes} generated ({len(all_records)} total rows)")

    df = pd.DataFrame(all_records)
    print(f"Simulation completed! Total generated rows: {len(df)}")
    return df


if __name__ == "__main__":
    df = generate_ares_v2_dataset(num_episodes=180, steps_per_episode=28)
    print(df.head())
    print(df["decision"].value_counts(normalize=True))

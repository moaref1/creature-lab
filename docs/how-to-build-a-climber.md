# Build a Climber from scratch

A four-limbed creature drawn from joints, bones and muscles learns to climb stairs. It starts on gentle steps and works up to tall ones. Then you build new worlds and test the same learned brain in them.

Allow 20 minutes, plus a few minutes of training.

## 1. The stairs (World)
1. Logo menu → **New from template…** → **Sketch creature**. Delete the Ground.
2. Select the world. View **side view (gravity down)**.
3. Drag in **Terrain**. Set Generator **stairs**, Length **60**, Step height **0.1**, Step width **1.6**, Flat start **13** (a short run-up), Position x **20**.
4. Tag it **ground** (terrain already has it). Keep the **Start** spawn point at x 0.
5. Make two more worlds the same way with Step height **0.25** (width 1.3) and **0.45** (width 1.1). (Or use **New world** in Evaluate to copy a world fast.)

## 2. The creature (Entity)
1. In **Entity** open the creature's **Body · joints, bones and muscles**.
2. Draw a torso: four joints as a box, bones around it and across one diagonal, one muscle on the other diagonal. Mark the front-top joint as the **Head** (tool **Head**).
3. Turn **⇋ Mirror** on and use the **Limb** tool: drag from a shoulder to grow a three-part arm with two bend muscles. Two long arms reach the next step. Legs the same way, drag downwards.
4. In the body set **Friction 2.5** (grip), **Joint mass 0.8**, **Muscle range 0.35**.
5. Add **Sensors · body sketch** (contact on, so each joint feels the ground), **Sensors · body state** (height on) and **Actuators · muscles**.

## 3. The brain (Brain)
Neural layer, Hidden `[24, 24]`, tanh. It sees joint contacts, tilt, muscle stretch, speed and height, and drives every muscle.

## 4. What counts as success (Reward)
Graph: **Progress** axis **x** → Term *forward* (weight 1), **Progress** axis **y** → Term *height gained* (weight **3**), **Energy** → Term *energy* (−0.03, per second) → **Score**. Height is worth more than distance, so it learns to go up, not just forward.

Scenario conditions: **Fell over** (part `head` touches `ground`) → fail, −1. **Travelled distance** x 12 m → success, +3. Episode **14 s**. Randomise the terrain's **step height** a little each episode so it doesn't memorise one staircase.

## 5. Curriculum and training
1. Three scenarios, one per world: *Gentle steps*, *Steps*, *Tall steps*.
2. **Reward → Curricula**: Gentle → Steps (promote at 60% success) → Tall.
3. **Train**: **Neuroevolution** (population 64, mutation 0.2 nudge, elitism 8) first. Press **Train**; the app jumps to the Train workspace. In a few seconds the *forward* curve starts to rise. PPO is the slower, smoother alternative.

## 6. Test it somewhere new (Evaluate)
1. Open **Evaluate**. In **Test in**, pick any scenario to replay the saved brains there.
2. Press **New world**. It copies the current world and its scenario, and sends you to **World**. Add walls, bigger steps, a gap or a ledge.
3. Back in **Evaluate** press **Replay**. The same trained brain plays in your new world. No retraining needed. If it struggles, train on the new world: pick it in the Train config and press **Train**; the run starts from your best brain (use **Fork** on the run).

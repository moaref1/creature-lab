# Build Tidepool from scratch

A small living pool seen from above. Darters (little fish) flock, eat plankton, fear the eel, make friends by nuzzling, grieve when a friend is caught, and slowly learn to trust you when you feed them by hand. Glowing drifters (jellies) swim by pulsing a soft body. A lazy eel hunts when hungry.

Everything here comes from the Add menus. Allow about 30 minutes.

## 1. The pool (World)
1. Logo menu → **New from template…** → **Blank 2D**. Delete the Ground and the Goal.
2. Select the world. Set **View: top-down (no gravity)**, **Ambience: water**, Background a deep teal (`#0d4656`).
3. Draw the shore: four thin **Box**es around a 27 × 15.6 m pool, tag **rock**. Add a few **Sphere** boulders inside, also tag **rock**.
4. Drag **Plant (kelp, grass)** in along the edges. Height 2.4–4, Sway 0.4. Tip: place one, then **Scatter copies…** in Properties to fill a bed of kelp at once.
5. Three anemones: **Plant**, Form **anemone**, Blades 14, tag **home**, bright pinks/purples.
6. Plankton: one small **Sphere** (0.26 m), tag **plankton**, affordance **edible**, Physics **sensor**, param `respawnArea` `[11, 6, 0]`. Then **Scatter copies…**: How many **11**, tick **Anywhere in the world**.
7. The treat for the Hand tool: one more small sphere named *Treat*, tags **treat** + **plankton**, edible, sensor, hidden, param `noRespawn: true`.
8. Three **Spawn point**s: *Reef* (middle), *Deep* (right), *Eel cave* (bottom right).

## 2. A feeling of your own
**Entity → Define a new component…**: name *Heart*, role **data**, one float field **trust** (0–1, default 0). This is the creature's trust in you.

## 3. The darter (Entity)
1. Body · rigid: box **0.8 · 0.4 · 0.2**, mass 1, friction 0, linear damping 1.2, **upright on**, **hit agents off**.
2. **Look · style**: Form **fish**, Glow 0.45, Eyes on, Trail 0.5, **Mood colours on** (calm teal, happy gold, afraid pale, sad blue). Add a Names list to give each fish its own name.
3. Feelings: **Needs**, **Emotion**, **Personality** (bravery!), **Relationships**, **Memory**, and your **Heart**.
4. Senses: **Target** sensors for `plankton`, `eel` and `hand`; **Nearby** darters reading their valence (moods spread); **Raycast** whiskers for `rock`; **Field** sensor for hunger, loneliness, valence, arousal, trust; **Body state**.
5. Actions: **Steering force** (max force 9, speed 3.6, face velocity) and **Choice** with two options:
   - *eat*: target `edible`, range 0.7 → hunger −0.35, valence +0.3
   - *nuzzle*: target `darter`, range 1, cooldown 3 → both feel less lonely
6. Add a variant *Brave darter* with bravery 0.95.

## 4. Drifter and eel
- **Drifter**: Add component → **Body · springs**, then in the viewport use the creature designer: **Mirror** on, draw a bell with the **Limb** tool, mark the rim links as muscles. Fluid drag **6** makes it swim in water. Look: Skin **jelly**, Glow 0.9. Sensors: **Spring sensor** (clock on). Actuator: **Muscles**.
- **Eel**: Body · rigid box 2.2 · 0.42, mass 4. Look Form **eel**. Needs, Steering force (5 / 3.1), Choice *bite* (target `darter`, range 1.2) → hunger −0.7.

## 5. Brains: instinct first, learning on top
Each brain has two layers: a **Neural** layer on top and a **Script** layer below as instinct. Whatever the network hasn't learned yet, the instinct does.
- Darter instinct: flocking (stay together, align, keep space), seek plankton when hungry, flee the eel with a sideways swerve, follow the hand when trust > 0.25, nuzzle when lonely.
- Drifter instinct: contract fast, relax slowly, on every muscle.
- Eel: script only. Hunt when hunger > 0.55, rest 8 s after a long chase.
The template's scripts are a good starting point. Open them in **Brain** to read and change them.

## 6. Feelings rules (Rules graph, scope: tag `darter`)
- Hunger and loneliness rise a little every second (**Add to feeling**, per second).
- Valence and arousal settle back (**Decay**).
- Hunger over 0.65 and loneliness over 0.55 lower valence.
- Eel within 4 m: valence down, arousal up (fear).
- Friends within 1.6 m: valence up, loneliness down.
- **Event** *bite* (as target) → **Respawn self** (hide 4 s): caught fish vanish and come back.
- **Event** *gone* → **Bond of** that fish × −1.6 → valence: grief, deeper for close friends.
- **Bond** on *nuzzle*: friendships grow.
- **Event** *eat* → **Has tag** `treat` → trust +0.25: the hand that feeds earns trust.
- **Consume** on *eat* (respawn 4 s) and **Remember** eat, nuzzle, gone, bite.
A second small graph for tag `eel`: hunger +0.035 per second.

## 7. A good life (Reward)
Terms → Score: *ate* +1, *caught* −3, *happy* (valence) +0.2 per second, *bumping rocks* −0.3 per second.

## 8. Scenario and training
- Scenario *A day in the pool*, 180 s, timeout = success. Spawns: 14 darters at Reef (spread 3, random yaw), 3 drifters at Deep, 1 eel at the cave. Randomise bravery, curiosity, hunger and starting mood so every fish is different.
- Train **Darters learn to live (PPO)**. For the jellies, scenario *Drifter swim school* (12 s, reach plankton = success) with **Genetic algorithm**.

## 9. Play
Press play. Pick the **Hand** tool: click to drop a treat. Shy fish wait, brave ones come first, and after a few treats the school follows your cursor. Select any fish to see its creature card: name, mood, needs, friends and what it remembers.

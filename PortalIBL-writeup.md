# PortalIBL: A Technique for Real-Time Rendering of Baked Reflections of Non-Convex Indoor Spaces

_Video embed here._

**[▶ Try the PortalIBL demo in your browser](https://andretinfante.github.io/portalgi/)** — runs on PC, mobile, and VR headsets · **[Source & full implementation on GitHub](https://github.com/AndreTInfante/portalgi)**


## Background 

Although the graphical frontier of the industry is moving towards raytraced reflections, on many platforms these methods remain too computationally heavy for routine use. In those cases, reflections (and more generally the specular components of physically based rendering) are often handled via HDR environment maps, often the [parallax-corrected](https://seblagarde.wordpress.com/2012/09/29/image-based-lighting-approaches-and-parallax-corrected-cubemap/) version, a form of image based lighting. 

The core idea is to capture a panoramic view of a given space from some central point, and bake it into image data. In the cheapest version, the image data is mapped onto an infinitely large skybox, so that ray position can be discarded, and only angle considered. In the slightly more expensive parallax corrected case, the boundary surface (often a scaled cuboid, but any convex shape can be used) is given finite extents, usually aligned (more or less) with the edges of the current room. At render time, rays can be efficiently tested against this hull to fetch the appropriate texel (using pre-blurred mips for less glossy reflections). 

This approach can, in the right circumstances, create fairly impressive reflection effects for minimal runtime cost, and is a common technique in mobile VR (and desktop as well: Half-Life: Alyx uses this technique extensively). You also see this as a common low-setting fallback in PC titles with raytraced reflections. The advantages are straightforward: the cost is usually trivial, you get photographic quality data, the projection is stereo-consistent when rendered for both eyes, and there’s no sampling noise that requires temporal accumulation to clean up. 

While this technique is fast and can give great results in some cases, it comes with some major drawbacks. The biggest one is the convexity requirement: as soon as you have any situation where a surface can be in front of another surface, the trick no longer works, and you need to do actual rendering for each pixel (real time cubemaps, ray tracing, or ray marching). These options become very expensive very quickly. This restriction causes nasty artifacting in non-convex rooms, and at apertures like doors. You end up with reflections that flatten complex spaces or obviously don’t align with geometry. Worse, this technology can push you towards boring level design where there’s an incentive to just make boxes, because boxes have better looking reflections. Because fixing these issues has generally required moving to a much heavier rendering approach, the general solution to this has largely been to shrug and tolerate it (it helps that on PC this problem is usually somewhat mitigated by screen space reflections). There has been a notable gap in the cost / fidelity pareto frontier.

## PortalIBL 

PortalIBL is a technique for generalizing [PCCM (Parallax-Corrected Cube Maps)](https://seblagarde.wordpress.com/2012/09/29/image-based-lighting-approaches-and-parallax-corrected-cubemap/) to mitigate these issues and competently address non-convex spaces, at least in the common cases (irregularly shaped rooms, and areas connected by doors and hallways). The technique is inspired by the [Build engine](https://en.wikipedia.org/wiki/Build_(game_engine))’s cell-and-portal rendering technique.

The idea here is simple: first, we use the generalization of PCCM to arbitrary convex hulls (a well known technique), but each hull can have multiple portals (defined as rectangles on faces for the purposes of the current demo), linked to other hulls. If a ray terminates at a portal, we check it against the environment map corresponding to that portal, and so on. This is very similar to how visibility worked in the Build engine back in the day. At the end of the recurse (either hitting the budget or an actual wall), we terminate, sample the last hull’s environment map as normal, and that’s our reflection. And that’s basically it! There’s some nuances to implementing it efficiently and cleaning up artifacts this introduces, but it’s not a complicated idea. Visually, though, it’s a huge improvement over PCCM, while being much cheaper than tracing-based methods. The method enables reflections through doors, and reflections of non-convex rooms (via decomposition into smaller convex sections linked by portals).

Here's the shader inner loop, condensed here from [`src/shaders.js`](https://github.com/AndreTInfante/portalgi/blob/main/src/shaders.js#L366):

```glsl
// traceSpec - walk the reflection ray through the convex-cell graph.
// A straight ray can never revisit a convex cell, so this always
// makes forward progress toward a real wall.
MP vec3 acc = vec3(0.0);
MP float w = 1.0;
for (int i = 0; i <= 8; i++) {
  // nearest exit plane of the current hull (analytic ray vs. convex hull)
  float bestT = 1e8; int bestPlane = -1;
  for (int j = 0; j < pc; j++) {
    vec4 pl = hfetch(cell, PLANES_OFF + j);
    float dn = dot(pl.xyz, dir);
    if (dn < -1e-5) {
      float t = -(dot(pl.xyz, pos) + pl.w) / dn;
      if (t < bestT) { bestT = t; bestPlane = j; }
    }
  }
  vec3 hitP = pos + dir * bestT;

  // if the exit plane carries a portal (bitmask test) and we still have
  // hop budget, look up the neighbor cell it links to; else nextCell stays -1
  int nextCell = -1; MP float blend = 0.0;
  if (i < maxHops && bestPlane >= 0) { /* portal scan -> nextCell, edge blend */ }

  vec3 localDir = hitP - h0.xyz;            // h0.xyz = this cell's capture point
  if (nextCell < 0 || blend <= 0.002) {     // hit a real wall: sample and stop
    acc += w * sampleSpec(cell, localDir, lod);
    return acc;
  }
  // crossing a portal: fold in the near side's edge-blend, then recurse
  acc += w * (1.0 - blend) * sampleSpec(cell, localDir, lod);
  w   *= blend;
  pos  = hitP + dir * 1e-3;
  cell = nextCell;
}
```  

_[screenshots go here]_

So what’s going on here, on the backend? We store each cell as a 512x512 octahedral environment map, with pre-filtered radiance stored in the mip chain (standard technique for glossy reflections), atlased together (along with mips and light probe data, which are just little texture patches storing irradiance). We have a live set of loaded hulls (you’d want to stream this in a real application, for the demo it’s baked). The whole live set lives in an std140 uniform block (~9Kb, 40 vec4 slots per cell), and is basically just a collection of <= 12 planes per hull to intersect against. By keeping this tiny, we keep it in fast-register-access world, which helps a lot with performance. We also store a per-cell mask indicating which faces are portals, and which cells they connect to. At render time, if we hit a portal, we check the same ray against that portal’s environment map instead (everything is tracked in world space, so this is trivial to do, no transformation needed). 

The entire per-cell record is only 40 `vec4`s - small enough to live in that std140 block and stay in registers ([`src/hulldata.js`](https://github.com/AndreTInfante/portalgi/blob/main/src/hulldata.js)):

```
Row y = cell id. Texels along x:
  0                capture.xyz, planeCount
  1                portalCount, floorY, ceilY, portal-plane bitmask
  2 .. 13          hull planes (n.xyz, d)   inside = dot(n,p)+d > 0
  14 + p*5         portal p: planeIndex, neighborCell, isVirtual, edge bitmask
  14 + p*5 + 1..4  portal edge planes (n.xyz, d)
  34 .. 36         irradiance-probe grid: bbox + dims
```

That per-cell portal-plane bitmask in texel 1 is an important optimization: a glossy pixel whose exit plane carries no portal skips the entire portal scan, so the common case stays close to the cost of a plain cubemap tap.

## Performance

Uncertain-length loops are pretty expensive: registers are allocated per program, so there’s a lot of waste in having dynamic loops, even if they usually early-out. The worst case register footprint is high, which hurts occupancy. If we had to do this for every pixel on screen, it’d be quite expensive. Fortunately, it turns out that in almost all cases, a single loop unroll (two environment map samples) is a totally adequate approximation, and fixes most of the problem cases. So we do some perceptual triage, mostly at compile time. There are a few cases to consider (assuming mobile-friendly performance limits).

- **Purely diffuse static and dynamic geometry:** Can totally ignore all of this and just rely on diffuse lightmap / irradiance probes. 
- **Semi-gloss static geometry:** Can use normal zero-hop PCCM, *unless* the geometry crosses a portal boundary, then it needs one hop to avoid a seam. Probably the smartest answer for this general category is directional lightmaps (not implemented in the demo).
- **Semi-gloss and glossy dynamic geometry:** Unrolled one-hop for stable reflections passing through portals.
- **Glossy static geometry:** Unrolled one hop. If you can see an image in it, you want at least one hop.
- **High gloss / chrome / glass:** This case wants full recursive traversal to a depth of ~3. Most pixels can early out (most pixels just reflect the walls), but you still have to pay for the worst-case register allocation. You can cut this down by tolerating some less-bad-than-PCCM artifacting, but honestly, in practice, you can mostly art direct your way around high gloss surfaces anyway. You know, rub some dirt on it.

This technique is significantly more expensive than PCCM (each hop is roughly 2 atlas taps + 1 extra hull-plane scan - the most common one-hop case is roughly twice the cost of normal cubemap sampling). However, the visual benefits are pretty significant (you can A/B test it in the demo if you don’t believe me) and PCCM is already dirt cheap. The demo runs at a locked 60 on my not-that-nice android phone and locked 72 on Quest 3 (90 in most scenes). Compared to what you’d need to do to get the same fidelity via real time cubemaps or ray marching or what have you, it’s a pretty good deal.

A cool thing about the portal approach is that it ~entirely removes the need for reflection probe blending (which is great because cross-fading high frequency visual information universally looks bad). Even on a highly glossy object, the discontinuity when passing between sectors is minimal. On real assets that are not a chrome ball, the transition is invisible, and it gives you a wonderfully smooth and visually plausible change in reflection as you go through doors. In normal PCCM, you often end up needing to sample two environment maps *anyway* for blending in these cases, and the portal transition looks a lot better than just cross-fading.

One subtlety around sampling: usually, in non-mirror reflections, you’re sampling pre-blurred images in the mip chain. This is problematic for portals, because while the pixels on both sides of a portal boundary are both valid approximations and represent valid radiance data, they are generated from completely different image data, and will not closely agree. By default, this gives you a hard pixel-perfect portal edge in the reflection, which shows up as a frequency space issue - a sharp line in data that should be blurry. To mitigate this, you need to sample both environment maps at portal boundaries, and cross-fade using a fade width equal to the width of the larger kernel involved. This keeps things smooth and avoids the perceptual artifact, at the cost of an additional texture sample. This also introduces some ghosting of the bad approximation over the good around the edges, but this is not visually obvious in practice, and could be avoided in various ways that I was too lazy to do for this demo. Once you’re past this blend width, it becomes a straight recurse and you don’t need to sample the first environment map at all.

In principle, all of this could be made fully deterministic (ray traversal through a portal is ‘only’ a 4d problem and can be baked to a LUT - see [`warpfield.js`](https://github.com/AndreTInfante/portalgi/blob/main/src/warpfield.js) in the repo for an implementation of this), but in practice the angular resolution required (<= 1 degree) to avoid artifacting required very large tables, so it wasn’t a good tradeoff compared to just capping traversal to a single unrolled hop for most surfaces.

For diffuse, we use a pretty standard light probe scheme, with probes allocated per-hull, and blended during portal transits. Static geometry uses vanilla, non-directional light mapping for the diffuse component. 

For more implementation details, you can check out [the repo](https://github.com/AndreTInfante/portalgi) for the demo. 

## Limitations

PortalIBL has a number of limitations, most of them in common with PCCM.


- Objects that are included in the bake get flattened against the walls, whether or not that makes sense. We mitigate this issue with the proxies discussed below.  
- If the proxy geometry doesn’t align perfectly, you also get misaligned reflections. You can see this issue in the demo where the planes for doors are in the center of the wall (to match the portal on the other side), which causes walls with doors to be slightly misaligned, cutting off the reflection of the wall footer and generally reflecting at a slightly incorrect depth - though you could patch this by interpolating the portal location to always be on the same side as the camera.
- This is purely a baked technique, and has no mechanism to represent large scale environment or lighting changes.
- If you cap the recursion depth (which you pretty much have to for performance on mobile), you still get PCCM-style artifacts on the last portal. They’re just less egregious because they mostly occur for reflections of doors through doors, and are (as a result) more distant (i.e. smaller and blurrier).

## What About Authoring?

Hull and portal rendering systems were famously kind of a pain in the ass to work with. I didn't attempt to solve that problem here: the hull construction is all manual (by which I mean I made an AI do it). However, I don’t think it’s intractable, you just need to cut the right balance between automation and tunability.

If I was implementing this as a scalable game engine feature, my basic approach would be to build a voxel based tool for capturing the explorable / lightable area, and turning it into a low-poly BSP-style mesh enclosing the negative space, and an optimization-based solver to automatically decompose this mesh into hulls that minimize various cost functions - e.g. cell fineness ratio, cell size, aligning as closely as possible to the volume boundaries, keeping cells convex, etc - maybe with the ability to provide “door plane” hints to the solver. The workflow would be to use the automated solution during level development, and once the level is locked, have the artist hand-tweak the volume mesh for performance, environment registration using brush-style tools, and to clean up any degenerate voxel jank (but still let the solver do the final decomposition). This allows you to pay the manual authoring tax only once, instead of every time the level gets modified.  


This is still not free in terms of complexity (especially if you have to implement the automated solvers), but it does have some other benefits. Once you have the hull and portal system, you can use it for light probe management, and for culling and probably streaming too. Often you want your level carved up anyway for various reasons - might as well also get nice reflections out of it.

## What Is All This Other Stuff?

The portal system was the main thing I intended to show off in the demo. Unfortunately, it looked so good that it made everything else look worse by comparison, and I got a little carried away (having access to Claude Fable, which makes graphics engineering almost ludicrously easy, definitely made this worse). So I ended up *also* implementing an analytic capsule-based proxy rendering system for representing in-scene objects in reflections and refractions. 

The big downside to PCCM and other shell based methods is that they flatten everything against the walls. For shallow objects near or against the wall this can be a super reasonable approximation. For large free standing objects in the middle of the room, it’s a pretty painful one. So, to mitigate these issues, this system takes a page from [Naughty Dog’s *The Last of Us*](https://www.youtube.com/watch?v=HL0REQjyp1M) and uses a capsule based representation to approximate meshes within the scene, which it uses for indirect reflections (computed per-surface pixel) and AO and shadows (computed in half-res lightmap space on quest for statics, per-surface-pixel for dynamics). Because these are density functions, we can get away with a single test for each effect, rather than needing to integrate and still get a nice smooth falloff. Each object is a collection of up to 8 capsules, and the system does some heuristic evaluation to determine which capsules are relevant enough to warrant inclusion in the hot loop (the capsule tests are cheap - but not free). For directional shadows, to avoid having to cast multiple shadows from multiple light sources, we just compute average lighting direction for the caster, and use that for the shadow rays. This is straightforwardly unphysical, but it gives you smooth behavior as the object moves around and makes costs low and consistent.

The reason one ray/point test per effect is enough is that each capsule contributes a *closed-form* occlusion term - Iñigo Quílez’s [analytic sphere occlusion](https://iquilezles.org/articles/sphereao/), evaluated at the closest point on the capsule’s axis ([`src/shaders.js`](https://github.com/AndreTInfante/portalgi/blob/main/src/shaders.js#L122)):

```glsl
// closest point on capsule segment A..B (u = B - A) to shaded point P
float t  = clamp(dot(P - A, u) / dot(u, u), 0.0, 1.0);
vec3  d  = A + u * t - P;
float d2 = max(dot(d, d), (r + clampDist) * (r + clampDist));
// Quilez sphere occlusion: cosine-weighted, falls off as radius^2 / dist^2
float occ = clamp(dot(N, d * inversesqrt(d2)), 0.0, 1.0) * (r * r) / d2;
ao *= 1.0 - occ * strength;   // up to 8 capsules per object, one tap each
```

This whole system is not very novel - tracing rays against collections of capsules to analytically approximate AO, shadows, and indirect occlusion is nothing new. However, it is *extremely* cool and very performant on mobile if set up properly. In conjunction with the PortalIBL trick, it creates an overall image that looks, to a first glance, like the result of real time raytracing. My internal-to-me codename for this project has been ‘We Have Raytracing At Home.’  

I’m not gonna go into too much detail here about how it works because it’s not a novel contribution ([the Naughty Dog presentation](https://www.youtube.com/watch?v=HL0REQjyp1M) is better than anything I would write), but if you’re interested in seeing a practical implementation, the code is available [on the repo](https://github.com/AndreTInfante/portalgi). 

## Is PortalIBL Actually a Novel Technique?

I think so? I’ve done some poking around and haven’t found any previous implementation or discussion of the idea, but that doesn’t mean it doesn’t exist somewhere. It seems like kind of an obvious idea in some ways, so it’d be a little surprising if nobody has thought of it before. If you previously invented and published this, let me know and I will credit you! Regardless, the technique seems pretty under-utilized, so promoting a cool demo of it seems like a good use of time either way. Lots of games ship with bad PCCM reflections, and this technique is cheap enough to be a pretty clear win in a lot of cases. 

## In Conclusion

This is a cool idea I had, it seems to work pretty well in practice, and if you’re a developer building stuff for lower end systems (especially XR), you should use it to make your games look nicer. I'm putting the demo out under an MIT license. Additionally, if you’re hiring game developers or XR people interested in graphics in the bay area or remote, you should consider hiring me. You can reach me via email at aticper{at}gmail.com, or on Twitter at [@AndreTI](https://twitter.com/AndreTI).

## References & Prior Work

- Sébastien Lagarde & Antoine Zanuttini. *Local Image-based Lighting with Parallax-corrected Cubemaps.* SIGGRAPH 2012 Talks. [Article](https://seblagarde.wordpress.com/2012/09/29/image-based-lighting-approaches-and-parallax-corrected-cubemap/) · [Slides & talk](https://seblagarde.wordpress.com/2012/11/28/siggraph-2012-talk/) - the parallax-corrected cubemap (PCCM) that PortalIBL generalizes.
- Michał Iwanicki. *Lighting Technology of The Last of Us.* SIGGRAPH 2013 Talks. [Talk video](https://www.youtube.com/watch?v=HL0REQjyp1M) - the capsule-based ambient occlusion and shadow representation the proxy system borrows.
- Iñigo Quílez. *Sphere ambient occlusion.* [iquilezles.org](https://iquilezles.org/articles/sphereao/) - the analytic occlusion term evaluated per capsule.
- *Build* engine (Ken Silverman, 1995) - the cell-and-portal visibility scheme PortalIBL borrows its traversal from. [Overview](https://en.wikipedia.org/wiki/Build_(game_engine))

**Demo:** <https://andretinfante.github.io/portalgi/> — **Source:** <https://github.com/AndreTInfante/portalgi>















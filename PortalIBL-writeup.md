PortalIBL - A Technique For Real Time Rendering of Baked Reflections of Non-Convex Indoor Spaces

Video Embed Here

Link: Try the PortalIBL demo in your browser!


Background: 

Although the graphical frontier of the industry is moving towards raytraced reflections, on many platforms these methods remain too computationally heavy for routine use. In those cases, reflections (and more generally the specular components of physically based rendering) are often handled via HDR environment maps, often the parallax corrected version, a form of image based lighting. The idea is to capture a panoramic view of a given space from some central point, and bake it into image data. In the cheapest version, the image data is mapped onto an infinitely large skybox, so that ray position can be discarded, and only angle considered. In the slightly more expensive parallax corrected case, the boundary surface (often a scaled cuboid, but any convex shape can be used) is given finite extents, usually aligned (more or less) with the edges of the current room. At render time, rays can be efficiently tested against this hull to fetch the appropriate texel (using pre-blurred mips for less glossy reflections). This can, in the right circumstances, create fairly impressive and quite cheap reflection effects, and is a common technique in mobile VR (and desktop as well: Half-Life: Alyx uses this technique extensively). You also see this as a common low-setting fallback in PC titles with raytraced reflections. The advantages are straightforward: the cost is usually trivial, you get photographic quality data, the projection is stereo-consistent when rendered for both eyes, and there’s no sampling noise that requires temporal accumulation to clean up. 

While this technique is fast and can give great results in some cases, it comes with some major drawbacks. The biggest one is the convexity requirement: as soon as you have any situation where a surface can be in front of another surface, the trick no longer works, and you need to do actual rendering for each pixel (real time cubemaps, ray tracing, or ray marching). These options become very expensive very quickly. This restriction causes nasty artifacting in non-convex rooms, and at apertures like doors. You end up with reflections that flatten complex spaces or obviously don’t align with geometry. Worse, this technology can push you towards boring level design where there’s an incentive to just make boxes, because boxes have better looking reflections. Because fixing these issues has generally required moving to a much heavier rendering approach, the general solution to this has largely been to shrug and tolerate it (it helps that on PC this problem is usually somewhat mitigated by screen space reflections). There has been a notable gap in the cost / fidelity pareto frontier.

PortalIBL: 

PortalIBL is a technique for generalizing PCCM (Parallax Corrected Cube Maps) to mitigate these issues and competently address non-convex spaces, at least in the common cases (irregularly shaped rooms, and areas connected by doors and hallways). The technique is inspired by the Build engine’s sector-and-portal based scheme. 

The idea here is simple: first, we use the generalization of PCCM to arbitrary convex hulls (a well known technique), but each hull can have multiple portals (defined as rectangles on faces for the purposes of the current demo), linked to other hulls. If a ray terminates at a portal, we check it against the environment map corresponding to that portal, and so on. This is very similar to how visibility worked in the Build engine back in the day. At the end of the recurse (either hitting the budget or an actual wall), we terminate, sample the last hull’s environment map as normal, and that’s our reflection. And that’s basically it! There’s some nuances to implementing it efficiently and cleaning up artifacts this introduces, but it’s not a complicated idea. Visually, though, it’s a huge improvement over PCCM, while being much cheaper than tracing-based methods. The method enables reflections through doors, and reflections of non-convex rooms (via decomposition into smaller convex sections linked by portals).  

[Screenshots]

So what’s going on here, on the backend? We store each cell as a 512x512 octahedral environment map, with pre-filtered radiance stored in the mip chain (standard technique for glossy reflections), atlased together (along with mips and light probe data, which are just little texture patches storing irradiance). We have a live set of loaded hulls (you’d want to stream this in a real application, for the demo it’s baked). The whole live set lives in an std140 uniform block (~10Kb, 40 vec4 slots per cell), and is basically just a collection of <= 12 planes per hull to intersect against. By keeping this tiny, we keep it in fast-register-access world, which helps a lot with performance. We also store a per-cell mask indicating which faces are portals, and which cells they connect to. At render time, if we hit a portal, we check the same ray against that portal’s environment map instead (everything is tracked in world space, so this is trivial to do, no transformation needed). 

These uncertain-length loops are pretty expensive: registers are allocated per program, so there’s a lot of waste in having dynamic loops, even if they usually early-out. The worst case register footprint is high, which hurts occupancy. If we had to do this for every pixel on screen, it’d be quite expensive. Fortunately, it turns out that in almost all cases, a single loop unroll (two environment map samples) is a totally adequate approximation, and fixes most of the problem cases. So we do some perceptual triage, mostly at compile time. There are a few cases to consider (assuming mobile-friendly performance limits).

Purely diffuse static and dynamic geometry: Can totally ignore all of this and just rely on diffuse lightmap / irradiance probes. 
Semi gloss static geometry: Can use normal zero-hop PCCM, *unless* the geometry crosses a portal boundary, then it needs one hop to avoid a seam. Probably the smartest answer for this general category is directional lightmaps (not implemented in the demo).
Semi-gloss and glossy dynamic geometry: Unrolled one-hop for stable reflections passing through portals.
Glossy static geometry: Unrolled one hop. If you can see an image in it, you want at least one hop.
High gloss / chrome / glass: This case wants full recursive traversal to a depth of ~3. Most pixels can early out (most pixels just reflect the walls), but you still have to pay for the worst-case register allocation. You can cut this down by tolerating some less-bad-than-PCCM artifacting, but honestly, in practice, you can mostly art direct your way around high gloss surfaces anyway. You know, rub some dirt on it.

While this technique is substantially more expensive than PCCM, the visual benefits are pretty significant (you can A/B test it in the demo if you don’t believe me) and PCCM is already dirt cheap. The demo runs at a locked 60 on my not-that-nice android phone and locked 72 on Quest 3 (almost 90 in most scenes, locked if you disable dynamic reflections). Compared to what you’d need to do to get the same fidelity via real time cubemaps or ray marching or what have you, it’s a pretty good deal, at least in its niche. 

A cool thing about the portal approach is that it ~entirely removes the need for reflection probe blending (which is great because cross-fading high frequency visual information universally looks bad). Even on a highly glossy object, the discontinuity when passing between sectors is minimal. On real objects that are not a chrome ball, the transition is invisible, and it gives you a wonderfully smooth and visually plausible change in reflection as you go through doors. In normal PCCM, you often end up needing to sample two environment maps *anyway* for blending in these cases, and the portal transition looks a lot better than just cross-fading.

One subtlety around sampling: usually, in non-mirror reflections, you’re sampling pre-blurred images in the mip chain. This is problematic for portals, because while the pixels on both sides of a portal boundary are both valid approximations and represent valid radiance data, they are generated from completely different image data, and will not closely agree. By default, this gives you a hard pixel-perfect portal edge in the reflection, which shows up as a frequency space issue - a sharp line in data that should be blurry. To mitigate this, you need to sample both environment maps at portal boundaries, and cross-fade using a fade width equal to the width of the larger kernel involved. This keeps things smooth and avoids the perceptual artifact, at the cost of an additional texture sample. This also introduces some ghosting of the bad approximation over the good around the edges, but this is not visually obvious in practice, and could be avoided in various ways that I was too lazy to do for this demo. Once you’re past this blend width, it becomes a straight recurse and you don’t need to sample the first environment map at all.

In principle, all of this could be made fully deterministic (ray traversal through a portal is ‘only’ a 4d problem and could theoretically be baked to a LUT), but in practice the angular resolution required to avoid artifacting required very large tables, and didn’t end up being practical.

For diffuse, we use a pretty standard light probe scheme, with probes allocated per-hull, and blended during portal transits. Static geometry uses vanilla, non-directional light mapping for the diffuse component. 

For more implementation details, you can check out the repo for the demo. 

What About Authoring?

Hull and portal rendering systems were famously kind of a pain in the ass to work with. And I didn’t solve that problem here: the hull construction is all manual (by which I mean I made an AI do it). However, I don’t think it’s intractable, you just need to cut the right balance between automation and tunability.

If I was implementing this as a scalable game engine feature, my basic approach would be to build a voxel based tool for capturing the explorable / lightable area, and turning it into a low-poly BSP-style mesh enclosing the negative space, and an optimization-based solver to automatically decompose this mesh into hulls that minimize various cost functions - e.g. cell fineness ratio, cell size, aligning as closely as possible to the volume boundaries, keeping cells convex, etc. Maybe with the ability to provide “door plane” hints to the solver. The workflow would be to use the automated solution during level development, and once the level is locked, have the artist hand-tweak the volume mesh for performance, environment registration using brush-style tools, and to clean up any degenerate voxel jank (but still let the solver do the final decomposition). This allows you to pay the manual authoring tax only once, instead of every time the level gets modified.  


This is still not free in terms of complexity (especially if you have to implement the automated solvers), but it does have some other benefits. Once you have the hull and portal system, you can use it for light probe management, and for culling and probably streaming too. Often you want your level carved up anyway for various reasons - might as well also get nice reflections out of it.

Okay But What About All The Other Stuff?

The portal system was the main thing I intended to show off in the demo. Unfortunately, it looked so good that it made everything else look worse by comparison, and I got a little carried away (having access to Claude Fable, which makes graphics engineering almost ludicrously easy, definitely made this worse). So I ended up *also* implementing an impostor-based rendering system for representing in-scene objects. 

The big downside to PCCM and other shell based methods is that they flatten everything against the walls. For shallow objects near or against the wall this can be a super reasonable approximation. For large free standing objects in the middle of the room, it’s a pretty painful one. So, to mitigate these issues, this system takes a page from The Last Of Us and uses a capsule based representation to approximate meshes within the scene, which it uses for indirect reflections (computed in screen pixel space) and AO and shadows (computed in half-res lightmap space on quest). Because these are density functions, we can get away with a single ray / point test for each effect, and still get a nice smooth falloff. Each object is a collection of up to 8 capsules, and the system does some heuristic evaluation to determine which capsules are relevant enough to warrant inclusion in the hot loop (the capsule tests are cheap - but not free). For directional shadows, to avoid having to cast multiple shadows from multiple light sources, we just compute average lighting direction for the caster, and use that for the shadow rays. This is straightforwardly unphysical, but it gives you smooth behavior as the object moves around and makes costs low and consistent.

This whole system is not very novel - tracing rays against collections of capsules to analytically approximate AO, shadows, and indirect occlusion is nothing new. But, it is *extremely* cool and very performant on mobile if set up properly. In conjunction with the PortalIBL trick, it creates an overall image that looks, to a first glance, like the result of real time raytracing. My internal-to-me codename for this project has been ‘We Have Raytracing At Home.’  

I’m not gonna go into too much detail about how it works because it’s not a novel contribution. If you’re interested, the code is available on the repo. 

Is PortalIBL Actually a Novel Technique?

I think so? I’ve done some poking around and haven’t come up with much, but that doesn’t mean it doesn’t exist somewhere. It seems like kind of an obvious idea in some ways, so it’d be a little surprising if nobody has thought of it before. If you previously invented and published this, let me know and I will credit you! Regardless, the technique seems pretty under-utilized, so promoting a cool demo of it seems like a good use of time either way. Lots of games ship with bad PCCM reflections, and this technique is cheap enough to be a pretty clear win in a lot of cases. 

In Conclusion

This is a cool idea I had, it seems to work pretty well in practice, and if you’re a developer building stuff for lower end systems (especially XR), you should use it to make your games look nicer. I’m open sourcing the demo I made and the technique more broadly (software patents being deeply evil). Additionally, if you’re hiring game developers or XR people interested in graphics in the bay area or remote, you should consider hiring me. You can reach me via email at aticper{at}gmail.com, or on Twitter at @AndreTI.















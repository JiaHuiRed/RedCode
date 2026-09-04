Generate an image from a text prompt, or edit an existing image, and show it inline in the conversation.

## When to use

- The user asks for a picture, illustration, icon, mockup, texture, or any visual asset.
- The user asks to modify an image they already have — change a background, restyle, swap an element.

Do not use it for charts or diagrams that carry data. Those belong in code or markdown, where the numbers stay readable and correctable.

## Writing the prompt

Write it in the language the user used; both Chinese and English work. Keep it within 512 units — each CJK character or Latin word counts as one.

Describe the subject first, then the style, then anything to exclude. Concrete nouns beat adjectives: "a sitting red cat, flat vector, white background, no text" gets you further than "a nice cat picture".

## Editing

Pass `image` with a path to edit that file instead of generating from scratch. Say what should change *and* what should stay: "change the background to solid red, keep the person unchanged" holds the subject still, while "change the background" alone has been observed to recolour adjacent things instead.

Source images are capped at 10MB.

## Result

The image is written into the project and rendered inline in the tool card. The output line carries the path, so it can be referenced later, read back, or handed to another tool.

# Browser-side Python (Skulpt): this runs entirely in the browser, with no
# server involved. Expect a turtle to draw a coloured spiral.
import turtle

t = turtle.Turtle()
t.speed(0)
colours = ["red", "orange", "gold", "green", "blue", "purple"]
for i in range(72):
    t.pencolor(colours[i % len(colours)])
    t.forward(i * 3)
    t.left(59)
print("Spiral finished.")

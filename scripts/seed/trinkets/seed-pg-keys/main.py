# Keyboard input through the game window. Click the game window, then use
# the arrow keys to move the square. Each move is also printed, so you can
# check key presses are reaching the program.
import pygame
import sys

pygame.init()
W, H = 800, 600
SIZE = 60
STEP = 20
screen = pygame.display.set_mode((W, H))
pygame.display.set_caption("Seed: arrow keys")
clock = pygame.time.Clock()
font = pygame.font.SysFont(None, 32)

x, y = (W - SIZE) // 2, (H - SIZE) // 2
moves = {
    pygame.K_LEFT: (-STEP, 0, "left"),
    pygame.K_RIGHT: (STEP, 0, "right"),
    pygame.K_UP: (0, -STEP, "up"),
    pygame.K_DOWN: (0, STEP, "down"),
}

while True:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            sys.exit()
        if event.type == pygame.KEYDOWN and event.key in moves:
            dx, dy, name = moves[event.key]
            x = max(0, min(W - SIZE, x + dx))
            y = max(0, min(H - SIZE, y + dy))
            print("moved", name, "to", (x, y))

    screen.fill((245, 245, 240))
    pygame.draw.rect(screen, (30, 120, 220), (x, y, SIZE, SIZE))
    screen.blit(font.render("Click here, then use the arrow keys", True, (40, 40, 40)), (10, 10))
    pygame.display.flip()
    clock.tick(30)

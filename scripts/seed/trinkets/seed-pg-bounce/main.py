# A pygame animation: bouncing balls at 60 frames a second, in the game
# window streamed over VNC. It also prints a line every 5 seconds, so text
# output is tested at the same time. Runs until you press Stop.
import pygame
import random
import sys
import time

pygame.init()
W, H = 800, 600
screen = pygame.display.set_mode((W, H))
pygame.display.set_caption("Seed: bounce")
clock = pygame.time.Clock()
font = pygame.font.SysFont(None, 32)

balls = []
for _ in range(15):
    balls.append([
        random.uniform(20, W - 20), random.uniform(20, H - 20),
        random.uniform(-4, 4), random.uniform(-4, 4),
        (random.randint(60, 255), random.randint(60, 255), random.randint(60, 255)),
    ])

frames = 0
started = time.time()
while True:
    for event in pygame.event.get():
        if event.type == pygame.QUIT:
            sys.exit()

    screen.fill((20, 24, 40))
    for b in balls:
        b[0] += b[2]
        b[1] += b[3]
        if b[0] < 15 or b[0] > W - 15:
            b[2] = -b[2]
        if b[1] < 15 or b[1] > H - 15:
            b[3] = -b[3]
        pygame.draw.circle(screen, b[4], (int(b[0]), int(b[1])), 15)

    frames += 1
    screen.blit(font.render("frame %d" % frames, True, (240, 240, 240)), (10, 10))
    pygame.display.flip()
    clock.tick(60)

    if frames % 300 == 0:
        print("%d frames, %.0f fps" % (frames, frames / (time.time() - started)))

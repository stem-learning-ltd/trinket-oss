# A deliberate crash. Expect the first average to print, then a traceback
# ending in ZeroDivisionError that points into average().
def average(numbers):
    return sum(numbers) / len(numbers)


print("Average of [2, 4, 6]:", average([2, 4, 6]))
print("Average of []:", average([]))
print("You should never see this line.")

"""
Trinket backend to override plt.show() with plt.savefig().
"""

from __future__ import (absolute_import, division, print_function,
                        unicode_literals)

# from matplotlib.externals import six

import matplotlib
from matplotlib.backends.backend_agg import new_figure_manager, FigureCanvasAgg
from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import RendererBase, GraphicsContextBase,\
     FigureManagerBase, FigureCanvasBase
from matplotlib.figure import Figure
from matplotlib.transforms import Bbox


########################################################################
#
# The following functions and classes are for pylab and implement
# window/figure managers, etc...
#
########################################################################

def show():
    for manager in Gcf.get_all_fig_managers():
        manager.canvas.figure.savefig("plot.png", bbox_inches="tight", pad_inches=0)


########################################################################
#
# Now just provide the standard names that backend.__init__ is expecting
#
########################################################################

FigureCanvas = FigureCanvasAgg

"""Two tiny ONNX graphs the engine uses for the heavy matrix products (run on the CPU by ONNX Runtime):

    gram.onnx    x [n, d]            -> g = x' x   [d, d]      (ridge training)
    matmul.onnx  a [n, k], b [k, m]  -> c = a b    [n, m]      (scoring many videos at once)

    python tools/make_aux_models.py        -> plugin/models/
"""
import os

import onnx
from onnx import TensorProto, helper

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'plugin', 'models')
os.makedirs(OUT, exist_ok=True)


def save(graph, name):
    m = helper.make_model(graph, opset_imports=[helper.make_opsetid('', 17)], producer_name='folder-suggest')
    m.ir_version = 8
    onnx.checker.check_model(m)
    onnx.save(m, os.path.join(OUT, name))
    print('wrote', name)


save(helper.make_graph(
    [helper.make_node('Transpose', ['x'], ['xt'], perm=[1, 0]), helper.make_node('MatMul', ['xt', 'x'], ['g'])],
    'gram',
    [helper.make_tensor_value_info('x', TensorProto.FLOAT, ['n', 'd'])],
    [helper.make_tensor_value_info('g', TensorProto.FLOAT, ['d', 'd'])],
), 'gram.onnx')

save(helper.make_graph(
    [helper.make_node('MatMul', ['a', 'b'], ['c'])],
    'matmul',
    [helper.make_tensor_value_info('a', TensorProto.FLOAT, ['n', 'k']),
     helper.make_tensor_value_info('b', TensorProto.FLOAT, ['k', 'm'])],
    [helper.make_tensor_value_info('c', TensorProto.FLOAT, ['n', 'm'])],
), 'matmul.onnx')

"""Experimental, unposed multi-image conditioning around the native TRELLIS.2 pipeline.

No torch/GPU imports until feature concatenation is needed. Native sampling, CFG,
guidance rescaling, sparse tensors and mesh/PBR decoding remain upstream's.
"""
from contextlib import contextmanager, ExitStack
from types import MethodType

MODES = ('stochastic', 'multidiffusion')
SAMPLERS = ('sparse_structure_sampler', 'shape_slat_sampler', 'tex_slat_sampler')
MIN_VIEWS, MAX_VIEWS = 2, 4


@contextmanager
def replace_method(owner, name, function):
    """Restore instance/class method lookup even when inference raises."""
    own = name in vars(owner)
    previous = vars(owner).get(name)
    setattr(owner, name, MethodType(function, owner))
    try:
        yield
    finally:
        if own:
            setattr(owner, name, previous)
        else:
            delattr(owner, name)


@contextmanager
def multi_image_conditioning(pipeline, images, mode, *, concatenate=None):
    count = len(images)
    if not MIN_VIEWS <= count <= MAX_VIEWS:
        raise ValueError(f'Multi-image experiment requires {MIN_VIEWS}–{MAX_VIEWS} views')
    if mode not in MODES:
        raise ValueError(f'Unknown multi-image fusion mode: {mode}')
    if concatenate is None:
        from torch import cat
        concatenate = cat
    original_condition = pipeline.get_cond
    samplers = [(name, getattr(pipeline, name)) for name in SAMPLERS]
    if not all(callable(getattr(sampler, '_inference_model', None)) for _, sampler in samplers):
        raise ValueError('Unsupported TRELLIS.2 sampler interface')
    stats = dict(input_views=count, fusion_mode=mode,
                 fusion_order='mean_of_native_guided_predictions' if mode == 'multidiffusion' else 'round_robin',
                 image_encoder_batch_size=1, condition_encodings=[], stages={})

    def get_cond(_pipeline, _image, resolution, include_neg_cond=True):
        # Encode sequentially: a batch of four 1024px DINO inputs can exceed the
        # single-card budget even though downstream generation has batch size one.
        conditions, negative = [], None
        for index, image in enumerate(images):
            encoded = original_condition([image], resolution, include_neg_cond=include_neg_cond and index == 0)
            conditions.append(encoded['cond'])
            if index == 0 and include_neg_cond:
                negative = encoded['neg_cond'][:1]
        result = dict(cond=concatenate(conditions, dim=0))
        if include_neg_cond:
            result['neg_cond'] = negative
        stats['condition_encodings'].append(dict(resolution=resolution, views=count))
        return result

    def inference_for(original, stage):
        def inference(_sampler, model, x_t, t, cond=None, **kwargs):
            if cond is None or len(cond) != count:
                raise ValueError('Image conditions do not match the selected views')
            if kwargs.get('neg_cond') is not None:
                kwargs = dict(kwargs, neg_cond=kwargs['neg_cond'][:1])
            step = stage['calls']
            stage['calls'] += 1
            indices = [step % count] if mode == 'stochastic' else range(count)
            combined = None
            for index in indices:
                # Calling the native guided sampler preserves its version-specific
                # CFG interval/rescale rules. This is not PR #104's pre-CFG mean.
                prediction = original(model, x_t, t, cond=cond[index:index+1], **kwargs)
                stage['view_forward_calls'][index] += 1
                if mode == 'stochastic':
                    return prediction
                contribution = prediction * (1 / count)
                combined = contribution if combined is None else combined + contribution
            return combined
        return inference

    with ExitStack() as stack:
        stack.enter_context(replace_method(pipeline, 'get_cond', get_cond))
        for name, sampler in samplers:
            stage = dict(calls=0, view_forward_calls=[0] * count)
            stats['stages'][name] = stage
            stack.enter_context(replace_method(sampler, '_inference_model', inference_for(sampler._inference_model, stage)))
        yield stats


def run_multi_image(pipeline, images, *, mode='multidiffusion', native_run=None, concatenate=None, **kwargs):
    if not MIN_VIEWS <= len(images) <= MAX_VIEWS or mode not in MODES:
        raise ValueError('Expected 2–4 images and a supported fusion mode')
    if kwargs.get('num_samples', 1) != 1:
        raise ValueError('Multi-image experiment generates one object, not a batch of objects')
    if mode == 'stochastic':
        for name in SAMPLERS:
            defaults = getattr(pipeline, name + '_params')
            steps = dict(defaults, **kwargs.get(name + '_params', {})).get('steps')
            if steps is None or steps < len(images):
                raise ValueError('Stochastic sampling needs enough steps to use every selected view')
    preprocess = kwargs.pop('preprocess_image', True)
    images = [pipeline.preprocess_image(image) for image in images] if preprocess else images
    native_run = native_run or pipeline.run
    with multi_image_conditioning(pipeline, images, mode, concatenate=concatenate) as stats:
        output = native_run(images[0], preprocess_image=False, **kwargs)
    if any(not all(stage['view_forward_calls']) for stage in stats['stages'].values()):
        raise RuntimeError('A TRELLIS.2 stage did not use every selected view')
    return output, stats
